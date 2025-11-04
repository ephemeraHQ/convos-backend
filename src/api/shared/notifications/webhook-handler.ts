import type { ClientIdentifier, DeviceRegistration } from "@prisma/client";
import type { Request, Response } from "express";
import { createApnsService } from "@/api/shared/notifications/services/apns-push.service";
import type { V2NotificationPayload } from "@/api/shared/notifications/services/notifications-types";
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
 * Detect if a message is a welcome message (XMTP MLS protocol message for group joins)
 * Welcome messages are too large (~5-8KB) for APNS payload limit (4KB)
 *
 * Detection methods:
 * 1. Content topic contains '/w-' (welcome topic pattern)
 * 2. Message type is 'v3-welcome'
 */
function isWelcomeMessage(args: {
  contentTopic: string;
  messageType: string;
}): boolean {
  return args.contentTopic.includes("/w-") || args.messageType === "v3-welcome";
}

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

    // Try v2 first (clientId lookup)
    const v2Client = await prisma.clientIdentifier.findUnique({
      where: { id: notification.installation.id },
      include: { device: true },
    });

    if (v2Client) {
      req.log.info(
        { clientId: notification.installation.id },
        "Processing v2 notification",
      );
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

    req.log.info(
      { installationId: notification.installation.id },
      "Processing v1 notification",
    );

    identityOnDeviceToCleanup = {
      xmtpInstallationId: identityOnDevice.xmtpInstallationId,
      deviceId: identityOnDevice.deviceId,
    };

    const { device, identity } = identityOnDevice;

    const isWelcome = isWelcomeMessage({
      contentTopic: notification.message.content_topic,
      messageType: notification.message_context.message_type,
    });

    if (isWelcome) {
      req.log.info(
        { contentTopic: notification.message.content_topic },
        "Detected welcome message - omitting encrypted content to avoid APNS payload limit",
      );
    }

    const result = await pushNotificationService.sendPushNotification({
      identityOnDevice,
      notification: {
        inboxId: identity.xmtpId,
        notificationType: "Protocol",
        notificationData: {
          contentTopic: notification.message.content_topic,
          messageType: notification.message_context.message_type,
          // Omit encryptedMessage for welcome messages (too large for APNS 4KB limit)
          // iOS NSE will handle notification display; app syncs from XMTP network
          ...(isWelcome
            ? {}
            : { encryptedMessage: notification.message.message }),
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

  // Only check manual disable flag (not failure count)
  if (client.device.disabled) {
    req.log.warn(
      { deviceId: client.deviceId },
      `Device is manually disabled. Skipping notification.`,
    );
    return { success: false };
  }

  // Log warning if high failure count but don't block
  if (client.device.pushFailures >= MAX_PUSH_FAILURES) {
    req.log.warn(
      {
        deviceId: client.deviceId,
        failures: client.device.pushFailures,
        lastFailureAt: client.device.lastFailureAt,
      },
      `Device has high failure count (${client.device.pushFailures}) but continuing`,
    );
  }

  // Generate JWT for NSE to use (24h expiration for security)
  const apiJWT = await createV2JwtToken({
    deviceId: client.deviceId,
    expirationTime: "24h",
    metadata: {
      notificationExtensionOnly: true,
    },
  });

  // NOTE: v2 only supports APNS/iOS push notifications
  // We do not support FCM/Android
  const apnsService = createApnsService();

  if (!apnsService) {
    req.log.error("APNS service not configured");
    return { success: false };
  }

  // Check if this is a welcome message (too large for APNS)
  const isWelcome = isWelcomeMessage({
    contentTopic: notification.message.content_topic,
    messageType: notification.message_context.message_type,
  });

  if (isWelcome) {
    req.log.info(
      { contentTopic: notification.message.content_topic },
      "Detected welcome message - omitting encrypted content to avoid APNS payload limit",
    );
  }

  // Send push notification with v2 types
  const v2Notification: V2NotificationPayload = {
    clientId: notification.installation.id,
    apiJWT,
    notificationType: "Protocol",
    notificationData: {
      contentTopic: notification.message.content_topic,
      messageType: notification.message_context.message_type,
      // Omit encryptedMessage for welcome messages (too large for APNS 4KB limit)
      ...(isWelcome ? {} : { encryptedMessage: notification.message.message }),
      timestamp: notification.message.timestamp_ns,
    },
  };

  // Create a device-like object for APNS service
  // NOTE: os is hardcoded to "ios" since v2 only supports APNS (no FCM/Android support)
  const deviceForApns = {
    id: client.deviceId,
    pushToken: client.device.pushToken,
    pushTokenType: client.device.pushTokenType,
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
    notification: v2Notification,
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
      { deviceId: client.deviceId },
      `Successfully sent v2 push notification`,
    );
  } else {
    // Increment failures without auto-disable
    const updated = await prisma.deviceRegistration.update({
      where: { deviceId: client.deviceId },
      data: {
        pushFailures: { increment: 1 },
        lastFailureAt: new Date(),
      },
    });

    // Log detailed error information
    req.log.error(
      {
        deviceId: client.deviceId,
        error: result.error,
        failureCount: updated.pushFailures,
        apnsEnv: client.device.apnsEnv,
        lastFailureAt: updated.lastFailureAt,
      },
      `Failed to send v2 push notification: ${result.error}`,
    );

    // Cleanup if unrecoverable error
    if (
      result.error === "DeviceNotRegistered" ||
      result.error === "BadDeviceToken"
    ) {
      req.log.info(
        { clientId: client.id, error: result.error },
        `Cleaning up v2 notification client due to unrecoverable error`,
      );
      try {
        // Delete from local DB first to ensure we don't retry on failure
        await prisma.clientIdentifier.delete({
          where: { id: client.id },
        });

        // Then attempt notification server cleanup
        try {
          await notificationClient.deleteInstallation({
            installationId: client.id,
          });
        } catch (xmtpError) {
          // Log but don't fail - DB is authoritative, orphaned XMTP installation is harmless
          req.log.warn(
            { error: xmtpError, clientId: client.id },
            "Failed to delete XMTP installation, but local DB is clean",
          );
        }

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
