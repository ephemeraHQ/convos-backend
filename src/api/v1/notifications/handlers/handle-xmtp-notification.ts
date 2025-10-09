import type { Request, Response } from "express";
import type { ClientIdentifier, DeviceRegistration } from "@prisma/client";
import {
  createNotificationClient,
  type WebhookNotificationBody,
} from "@/notifications/client";
import { getHttpDeliveryNotificationAuthHeader } from "@/notifications/utils";
import { prisma } from "@/utils/prisma";
import { createV2JwtToken } from "@/utils/v2/jwt";
import { getPushNotificationService } from "../services/push-notification.service";
import { createApnsService } from "../services/apns-push.service";

const notificationClient = createNotificationClient();
const pushNotificationService = getPushNotificationService();

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
    const notification = req.body as WebhookNotificationBody;

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

    // TRY V2 FIRST (clientIdentifier lookup)
    const v2Client = await prisma.clientIdentifier.findUnique({
      where: { id: notification.installation.id },
      include: { device: true },
    });

    if (v2Client) {
      req.log.info("Processing v2 notification");
      const result = await handleV2Notification({
        notification,
        client: v2Client,
        req,
      });
      res.status(200).end();
      return;
    }

    // FALLBACK TO V1 (xmtpInstallationId lookup)
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
      req.log.error(
        `Installation not found (v1 or v2) for installationId ${notification.installation.id}`,
      );
      res.status(400).json({
        error: `Installation not found for installationId ${notification.installation.id}`,
      });
      return;
    }

    req.log.info("Processing v1 notification");

    identityOnDeviceToCleanup = {
      xmtpInstallationId: identityOnDevice.xmtpInstallationId,
      deviceId: identityOnDevice.deviceId,
    };

    const { device, identity } = identityOnDevice;

    const result = await pushNotificationService.sendPushNotification({
      identityOnDevice,
      notification: {
        inboxId: identity.xmtpId,
        notificationType: "Protocol",
        notificationData: {
          contentTopic: notification.message.content_topic,
          messageType: notification.message_context.message_type,
          encryptedMessage: notification.message.message,
          timestamp: notification.message.timestamp_ns,
        },
      },
    });

    if (!result.success && result.shouldCleanup) {
      req.log.info(
        `Push notification failed with unrecoverable error for device ${device.id}. Initiating cleanup.`,
      );
      if (identityOnDeviceToCleanup.xmtpInstallationId) {
        await cleanupFailedInstallation({
          xmtpInstallationId: identityOnDeviceToCleanup.xmtpInstallationId,
          deviceId: identityOnDeviceToCleanup.deviceId,
          req,
        });
      }
    }

    res.status(200).end();
    return;
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
          pushToken: null,
          pushFailures: { increment: 1 },
        },
      }),
    ]);
    req.log.info(
      `Successfully cleaned xmtpInstallationId ${xmtpInstallationId} and tokens for device ${deviceId} from local DB.`,
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

async function handleV2Notification(args: {
  notification: WebhookNotificationBody;
  client: ClientIdentifier & { device: DeviceRegistration };
  req: Request;
}) {
  const { notification, client, req } = args;

  // Check if device is disabled or has too many failures
  if (client.device.disabled || client.device.pushFailures >= 10) {
    req.log.warn(
      `Device ${client.deviceId} is disabled or has too many failures. Skipping notification.`,
    );
    return { success: false };
  }

  // Generate JWT for NSE to use
  const apiJWT = await createV2JwtToken({
    clientIdentifier: client.id,
    deviceId: client.deviceId,
    expirationTime: "72h",
    metadata: {
      notificationExtensionOnly: true,
    },
  });

  // Create APNS service
  const apnsService = createApnsService();

  if (!apnsService) {
    req.log.error("APNS service not configured");
    return { success: false };
  }

  // Send push notification
  const result = await apnsService.sendPushNotification({
    device: {
      id: client.deviceId,
      pushToken: client.device.pushToken,
      pushTokenType: client.device.tokenType,
      apnsEnv: client.device.apnsEnv,
      pushFailures: client.device.pushFailures,
    } as any,
    notification: {
      clientIdentifier: client.id,
      apiJWT,
      notificationType: "Protocol",
      notificationData: {
        contentTopic: notification.message.content_topic,
        messageType: notification.message_context.message_type,
        encryptedMessage: notification.message.message,
        timestamp: notification.message.timestamp_ns,
      },
    } as any,
  });

  // Track success/failure
  if (result.success) {
    await prisma.deviceRegistration.update({
      where: { deviceId: client.deviceId },
      data: {
        pushFailures: 0,
        lastSentAt: new Date(),
      },
    });
    req.log.info(`Successfully sent v2 push notification to ${client.deviceId}`);
  } else {
    const newFailureCount = client.device.pushFailures + 1;
    await prisma.deviceRegistration.update({
      where: { deviceId: client.deviceId },
      data: {
        pushFailures: newFailureCount,
        lastFailureAt: new Date(),
        disabled: newFailureCount >= 10,
      },
    });
    req.log.warn(
      `Failed to send v2 push notification to ${client.deviceId}. Failure count: ${newFailureCount}`,
    );

    // Cleanup if unrecoverable error
    if (result.error === "DeviceNotRegistered" || result.error === "BadDeviceToken") {
      req.log.info(`Cleaning up v2 client ${client.id} due to unrecoverable error`);
      await notificationClient.deleteInstallation({
        installationId: client.id,
      });
      await prisma.clientIdentifier.delete({
        where: { id: client.id },
      });
    }
  }

  return result;
}
