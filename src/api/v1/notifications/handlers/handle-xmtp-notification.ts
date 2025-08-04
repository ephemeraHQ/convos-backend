import { Expo, type ExpoPushMessage } from "expo-server-sdk";
import type { Request, Response } from "express";
import {
  createNotificationClient,
  type NotificationResponse,
} from "@/notifications/client";
import { getHttpDeliveryNotificationAuthHeader } from "@/notifications/utils";
import { prisma } from "@/utils/prisma";

const expo = new Expo();
const notificationClient = createNotificationClient();

// Name of the token we send from the simulator
const TEST_TOKEN = "TEST_EXPO_TOKEN";

if (!process.env.XMTP_NOTIFICATION_SECRET) {
  throw new Error("XMTP_NOTIFICATION_SECRET is not set");
}

/**
 * Webhook handler for XMTP notifications
 *
 * This endpoint uses custom header-based authentication instead of the standard authMiddleware.
 * It validates the request using the XMTP_NOTIFICATION_SECRET to verify the webhook is coming
 * from the authorized XMTP server.
 */
export async function handleXmtpNotification(req: Request, res: Response) {
  let identityOnDeviceToCleanup: {
    xmtpInstallationId: string | null;
    deviceId: string;
  } | null = null;

  try {
    const notification = req.body as NotificationResponse;

    // Log the notification for debugging
    req.log.info(
      {
        contentTopic: notification.message.content_topic,
        installationId: notification.installation.id,
      },
      "received notification",
    );

    // Verify the authorization header
    const authHeader = req.headers.authorization;
    const expectedAuthHeader = getHttpDeliveryNotificationAuthHeader();

    if (!authHeader || authHeader !== expectedAuthHeader) {
      req.log.error("Invalid or missing authorization header");
      res.status(401).json({
        error: "Unauthorized: Invalid authentication token",
      });
      return;
    }

    // Check if this notification should trigger a push
    if (!notification.message_context.should_push) {
      res.status(200).end();
      return;
    }

    const identityOnDevice = await prisma.identitiesOnDevice.findUnique({
      where: {
        xmtpInstallationId: notification.installation.id,
      },
      include: {
        device: true,
        identity: true,
      },
    });

    if (!identityOnDevice || !identityOnDevice.xmtpInstallationId) {
      // Trying old way of sending notifications
      const device = await prisma.device.findFirst({
        where: {
          pushToken: notification.installation.delivery_mechanism.token,
        },
        include: {
          identities: {
            include: {
              identity: true,
            },
          },
        },
      });
      if (
        device &&
        device.expoToken &&
        device.identities.length > 0 &&
        device.identities[0].identity.turnkeyAddress
      ) {
        await trySendingNotificationWithOldway({
          notification,
          ethAddress: device.identities[0].identity.turnkeyAddress,
          expoPushToken: device.expoToken,
          req,
        });
        res.status(200).end();
        return;
      }

      req.log.warn(
        `No active device/identity found for xmtpInstallationId ${notification.installation.id}. This installation might have been cleaned up already.`,
      );
      try {
        await notificationClient.deleteInstallation({
          installationId: notification.installation.id,
        });
        req.log.info(
          `Requested deletion of orphaned xmtpInstallationId ${notification.installation.id} from XMTP server.`,
        );
      } catch (deleteError) {
        req.log.error(
          { error: deleteError },
          `Failed to request deletion of orphaned xmtpInstallationId ${notification.installation.id}`,
        );
      }
      res.status(200).end();
      return;
    }

    identityOnDeviceToCleanup = {
      xmtpInstallationId: identityOnDevice.xmtpInstallationId,
      deviceId: identityOnDevice.deviceId,
    };

    const { device, identity } = identityOnDevice;
    const expoPushToken = device.expoToken;
    const pushToken = device.pushToken;
    const pushTokenType = device.pushTokenType as string | null;
    const turnkeyAddress = identity.turnkeyAddress;

    if (!turnkeyAddress) {
      req.log.error(
        `DeviceIdentity ${identity.id} for xmtpInstallationId ${notification.installation.id} has no turnkeyAddress`,
      );
      res.status(200).end();
      return;
    }

    if (expoPushToken === TEST_TOKEN) {
      req.log.info("Skipping notification for test token");
      res.status(200).end();
      return;
    }

    // Check if device has too many push failures
    if (device.pushFailures > 10) {
      req.log.warn(
        `Device ${device.id} has too many push failures (${device.pushFailures}). Skipping notification.`,
      );
      res.status(200).end();
      return;
    }

    // Prefer new push token over legacy expo token
    const effectivePushToken = pushToken || expoPushToken;
    const effectiveTokenType = pushTokenType || "expo";

    if (!effectivePushToken) {
      req.log.warn(
        `No push token available for Device ${device.id} (xmtpInstallationId ${notification.installation.id}). Cleaning up.`,
      );
      if (identityOnDeviceToCleanup.xmtpInstallationId) {
        await cleanupFailedInstallation({
          xmtpInstallationId: identityOnDeviceToCleanup.xmtpInstallationId,
          deviceId: identityOnDeviceToCleanup.deviceId,
          req,
        });
      }
      res.status(200).end();
      return;
    }

    // For Expo tokens, validate format
    if (
      effectiveTokenType === "expo" &&
      !Expo.isExpoPushToken(effectivePushToken)
    ) {
      req.log.warn(
        `Expo push token for Device ${device.id} (xmtpInstallationId ${notification.installation.id}) is invalid. Cleaning up.`,
      );
      if (identityOnDeviceToCleanup.xmtpInstallationId) {
        await cleanupFailedInstallation({
          xmtpInstallationId: identityOnDeviceToCleanup.xmtpInstallationId,
          deviceId: identityOnDeviceToCleanup.deviceId,
          req,
        });
      }
      res.status(200).end();
      return;
    }

    const baseMessageData = {
      contentTopic: notification.message.content_topic,
      messageType: notification.message_context.message_type,
      encryptedMessage: notification.message.message,
      timestamp: notification.message.timestamp_ns,
      ethAddress: turnkeyAddress,
    };

    // Only handle Expo tokens for now (APNS support can be added later)
    if (effectiveTokenType !== "expo") {
      req.log.warn(
        `Push token type ${effectiveTokenType} not yet supported for Device ${device.id}. Skipping notification.`,
      );
      res.status(200).end();
      return;
    }

    const message: ExpoPushMessage = notification.subscription.is_silent
      ? {
          to: effectivePushToken,
          data: baseMessageData,
          _contentAvailable: true,
          priority: "normal",
          sound: undefined,
        }
      : {
          to: effectivePushToken,
          sound: "default",
          body: "New message",
          data: baseMessageData,
          priority: "high",
          mutableContent: true,
        };

    const chunks = expo.chunkPushNotifications([message]);

    for (const chunk of chunks) {
      try {
        const tickets = await expo.sendPushNotificationsAsync(chunk);

        for (const ticket of tickets) {
          const expoPushReceipt = ticket;

          if (expoPushReceipt.status === "error") {
            req.log.error(
              {
                details: expoPushReceipt.details,
                xmtpInstallationId: notification.installation.id,
              },
              `Error sending push notification: ${expoPushReceipt.message}`,
            );

            // Increment push failures for this device
            await incrementPushFailures(device.id, req);

            if (
              expoPushReceipt.details &&
              expoPushReceipt.details.error === "DeviceNotRegistered"
            ) {
              req.log.info(
                `DeviceNotRegistered error for token ${effectivePushToken} (xmtpInstallationId ${notification.installation.id}). Initiating cleanup.`,
              );

              if (identityOnDeviceToCleanup.xmtpInstallationId) {
                await cleanupFailedInstallation({
                  xmtpInstallationId:
                    identityOnDeviceToCleanup.xmtpInstallationId,
                  deviceId: identityOnDeviceToCleanup.deviceId,
                  req,
                });
              }
            }
          } else {
            // Success - update last push success timestamp
            await updateLastPushSuccess(device.id, req);
          }
        }
      } catch (error) {
        req.log.error(
          { error, xmtpInstallationId: notification.installation.id },
          "Critical error sending push notifications chunk",
        );
      }
    }

    res.status(200).end();
  } catch (error) {
    req.log.error({ error }, "Outer error processing notification");
    res.status(500).json({ error: "Internal server error" });
  }
}

async function cleanupFailedInstallation(args: {
  xmtpInstallationId: string;
  deviceId: string;
  req: Request;
}) {
  const { xmtpInstallationId, deviceId, req } = args;

  try {
    req.log.info(
      `Cleaning up installation: ${xmtpInstallationId} for device: ${deviceId}`,
    );
    await prisma.$transaction([
      prisma.identitiesOnDevice.updateMany({
        where: { xmtpInstallationId: xmtpInstallationId },
        data: { xmtpInstallationId: null },
      }),
      prisma.device.update({
        where: { id: deviceId },
        data: {
          expoToken: null,
          pushToken: null,
          pushFailures: { increment: 1 },
        },
      }),
    ]);
    req.log.info(
      `Successfully cleaned xmtpInstallationId ${xmtpInstallationId} and expoToken for device ${deviceId} from local DB.`,
    );

    await notificationClient.deleteInstallation({
      installationId: xmtpInstallationId,
    });
    req.log.info(
      `Successfully requested deletion of xmtpInstallationId ${xmtpInstallationId} from XMTP server.`,
    );
  } catch (cleanupError) {
    req.log.error(
      { error: cleanupError, xmtpInstallationId, deviceId },
      "Failed during cleanup of installation",
    );
  }
}

async function trySendingNotificationWithOldway(args: {
  notification: NotificationResponse;
  ethAddress: string;
  expoPushToken: string;
  req: Request;
}) {
  const { notification, ethAddress, expoPushToken, req } = args;

  // Prepare the base message data that's common for both silent and regular notifications
  const baseMessageData = {
    contentTopic: notification.message.content_topic,
    messageType: notification.message_context.message_type,
    encryptedMessage: notification.message.message,
    timestamp: notification.message.timestamp_ns,
    ethAddress: ethAddress,
  };

  // Create the message based on whether it's silent or regular
  const message: ExpoPushMessage = notification.subscription.is_silent
    ? {
        // Silent notification configuration
        to: expoPushToken,
        data: baseMessageData,
        // Required for iOS silent notifications
        _contentAvailable: true,
        // Required for Android silent notifications
        priority: "normal",
        // Ensure no visible alerts
        sound: undefined,
      }
    : {
        // Regular notification configuration
        to: expoPushToken,
        sound: "default",
        body: "New message",
        data: baseMessageData,
        priority: "high",
        mutableContent: true,
      };

  // Send the notification
  const chunks = expo.chunkPushNotifications([message]);
  const sendPromises = chunks.map(async (chunk) => {
    try {
      const ticketChunk = await expo.sendPushNotificationsAsync(chunk);
      req.log.info({ ticketChunk }, "push notification sent");
      return ticketChunk;
    } catch (error) {
      req.log.error({ error }, "Error sending push notification:");
      throw error;
    }
  });

  await Promise.all(sendPromises);
}

async function incrementPushFailures(deviceId: string, req: Request) {
  try {
    await prisma.device.update({
      where: { id: deviceId },
      data: { pushFailures: { increment: 1 } },
    });
    req.log.info(`Incremented push failures for device ${deviceId}`);
  } catch (error) {
    req.log.error({ error, deviceId }, "Failed to increment push failures");
  }
}

async function updateLastPushSuccess(deviceId: string, req: Request) {
  try {
    await prisma.device.update({
      where: { id: deviceId },
      data: {
        lastPushSuccessAt: new Date(),
        pushFailures: 0, // Reset failures on successful push
      },
    });
    req.log.info(`Updated last push success for device ${deviceId}`);
  } catch (error) {
    req.log.error({ error, deviceId }, "Failed to update last push success");
  }
}
