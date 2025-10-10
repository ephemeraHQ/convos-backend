import type { ClientIdentifier, DeviceRegistration } from "@prisma/client";
import type { Request, Response } from "express";
import { createApnsService } from "@/api/shared/notifications/services/apns-push.service";
import type {
  NotificationPayloadWithJWTToken,
  V2NotificationPayload,
} from "@/api/shared/notifications/services/notifications-types";
import { getPushNotificationService } from "@/api/shared/notifications/services/push-notification.service";
import {
  createNotificationClient,
  webhookNotificationBodySchema,
  type WebhookNotificationBody,
} from "@/notifications/client";
import { prisma } from "@/utils/prisma";
import { createV2JwtToken } from "@/utils/v2/jwt";
import { MAX_PUSH_FAILURES } from "./constants";

const notificationClient = createNotificationClient();
const pushNotificationService = getPushNotificationService();

/**
 * Webhook handler for XMTP notifications
 *
 * Authentication is handled by xmtpWebhookAuthMiddleware which validates the
 * XMTP_NOTIFICATION_SECRET header to verify the request is from the authorized XMTP server.
 */
export async function handleXmtpNotification(req: Request, res: Response) {
  let identityOnDeviceToCleanup: {
    xmtpInstallationId: string | null;
    deviceId: string;
  } | null = null;

  try {
    // Validate webhook body structure
    const parseResult = webhookNotificationBodySchema.safeParse(req.body);
    if (!parseResult.success) {
      req.log.error(
        { errors: parseResult.error.errors },
        "Invalid webhook payload",
      );
      res.status(400).json({
        error: "Invalid webhook payload",
        details: parseResult.error.errors,
      });
      return;
    }

    const notification = parseResult.data;

    // Log the notification for debugging
    req.log.info(
      {
        contentTopic: notification.message.content_topic,
        installationId: notification.installation.id,
      },
      "received notification",
    );

    // Try v2 first (clientIdentifier lookup)
    const v2Client = await prisma.clientIdentifier.findUnique({
      where: { id: notification.installation.id },
      include: { device: true },
    });

    if (v2Client) {
      req.log.info("Processing v2 notification");
      await handleV2Notification({
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
        `Installation not found for installationId ${notification.installation.id}`,
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
  if (
    client.device.disabled ||
    client.device.pushFailures >= MAX_PUSH_FAILURES
  ) {
    req.log.warn(
      `Device ${client.deviceId} is disabled or has too many failures. Skipping notification.`,
    );
    return { success: false };
  }

  // Generate JWT for NSE to use (24h expiration for security)
  const apiJWT = await createV2JwtToken({
    deviceId: client.deviceId,
    clientIdentifier: client.id,
    expirationTime: "24h",
    metadata: {
      notificationExtensionOnly: true,
    },
  });

  // NOTE: v2 currently only supports APNS/iOS push notifications
  // Android/FCM support can be added when needed by using pushNotificationService
  // and deriving OS from tokenType (see v1 implementation above)
  const apnsService = createApnsService();

  if (!apnsService) {
    req.log.error("APNS service not configured");
    return { success: false };
  }

  // Send push notification with v2 types
  const v2Notification: V2NotificationPayload = {
    clientIdentifier: client.id,
    apiJWT,
    notificationType: "Protocol",
    notificationData: {
      contentTopic: notification.message.content_topic,
      messageType: notification.message_context.message_type,
      encryptedMessage: notification.message.message,
      timestamp: notification.message.timestamp_ns,
    },
  };

  // Create a device-like object for APNS service
  // NOTE: os is hardcoded to "ios" since v2 only supports APNS for now
  const deviceForApns = {
    id: client.deviceId,
    pushToken: client.device.pushToken,
    pushTokenType: client.device.tokenType,
    apnsEnv: client.device.apnsEnv,
    pushFailures: client.device.pushFailures,
    name: null,
    os: "ios" as const,
    appVersion: null,
    appBuildNumber: null,
    createdAt: client.device.addedAt,
    updatedAt: client.device.updatedAt,
    lastPushSuccessAt: client.device.lastSentAt,
  };

  const result = await apnsService.sendPushNotification({
    device: deviceForApns,
    notification: v2Notification as unknown as NotificationPayloadWithJWTToken,
  });

  // Track success/failure using atomic operations to prevent race conditions
  if (result.success) {
    await prisma.deviceRegistration.update({
      where: { deviceId: client.deviceId },
      data: {
        pushFailures: { set: 0 },
        lastSentAt: new Date(),
      },
    });
    req.log.info(
      `Successfully sent v2 push notification to ${client.deviceId}`,
    );
  } else {
    // Use atomic increment and fetch the result to check threshold
    const updated = await prisma.deviceRegistration.update({
      where: { deviceId: client.deviceId },
      data: {
        pushFailures: { increment: 1 },
        lastFailureAt: new Date(),
      },
    });

    // Check if we've hit the threshold and need to disable
    if (updated.pushFailures >= MAX_PUSH_FAILURES && !updated.disabled) {
      await prisma.deviceRegistration.update({
        where: { deviceId: client.deviceId },
        data: { disabled: true },
      });
    }

    req.log.warn(
      `Failed to send v2 push notification to ${client.deviceId}. Failure count: ${updated.pushFailures}`,
    );

    // Cleanup if unrecoverable error
    if (
      result.error === "DeviceNotRegistered" ||
      result.error === "BadDeviceToken"
    ) {
      req.log.info(
        `Cleaning up v2 notification client ${client.id} due to unrecoverable error`,
      );
      try {
        await notificationClient.deleteInstallation({
          installationId: client.id,
        });

        await prisma.clientIdentifier.delete({
          where: { id: client.id },
        });

        req.log.info(
          { clientId: client.id },
          "Successfully cleaned up v2 notifications",
        );
      } catch (cleanupError) {
        req.log.error(
          { error: cleanupError, clientId: client.id },
          "Failed to cleanup v2 notification subscriptions after push failure",
        );
        // Don't throw here - this is already in error handling path
      }
    }
  }

  return result;
}
