import type { ClientIdentifier, DeviceRegistration } from "@prisma/client";
import type { Request, Response } from "express";
import { createApnsService } from "@/api/v2/notifications/apns-push.service";
import { createFcmService } from "@/api/v2/notifications/fcm-push.service";
import type { V2NotificationPayload } from "@/api/v2/notifications/types";
import {
  createNotificationClient,
  webhookNotificationBodySchema,
  type WebhookNotificationBody,
} from "@/notifications/client";
import { createJwtToken } from "@/utils/jwt";
import { prisma } from "@/utils/prisma";
import {
  APNS_MAX_PAYLOAD_BYTES,
  FCM_MAX_PAYLOAD_BYTES,
  MAX_PUSH_FAILURES,
  PUSH_PAYLOAD_STRIP_MARGIN_BYTES,
} from "../constants";

const notificationClient = createNotificationClient();

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
 * Notifications webhook handler
 *
 * Authentication is handled by webhookAuthMiddleware which validates the
 * XMTP_NOTIFICATION_SECRET header to verify the request is from the authorized XMTP server.
 */
export async function handleXmtpNotification(req: Request, res: Response) {
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

    // Log the incoming webhook for debugging
    req.log.info(
      {
        contentTopic: notification.message.content_topic,
        messageType: notification.message_context.message_type,
        installationId: notification.installation.id,
        timestampNs: notification.message.timestamp_ns,
      },
      "Received XMTP notification webhook",
    );

    // Process v2 notifications (clientId lookup)
    const v2Client = await prisma.clientIdentifier.findUnique({
      where: { id: notification.installation.id },
      include: { device: true },
    });

    if (v2Client) {
      const pushType = v2Client.device.pushTokenType; // 'fcm' | 'apns'
      const tag = pushType === "fcm" ? "[FCM]" : "[APNS]";
      req.log.info(
        {
          clientId: notification.installation.id,
          deviceId: v2Client.deviceId,
          pushTokenType: pushType,
          hasPushToken: !!v2Client.device.pushToken,
          apnsEnv: v2Client.device.apnsEnv,
          disabled: v2Client.device.disabled,
          pushFailures: v2Client.device.pushFailures,
        },
        `${tag} Processing v2 notification`,
      );
      await handleV2Notification({
        notification,
        client: v2Client,
        req,
      });
      res.status(200).end();
      return;
    }

    res.status(200).end();
    return;
  } catch (error) {
    req.log.error({ error }, "Outer error processing notification");
    res.status(500).json({ error: "Internal server error" });
  }
}

export async function handleV2Notification(args: {
  notification: WebhookNotificationBody;
  client: ClientIdentifier & { device: DeviceRegistration };
  req: Request;
}) {
  const { notification, client, req } = args;

  const pushType = client.device.pushTokenType; // 'fcm' | 'apns'
  const tag = pushType === "fcm" ? "[FCM]" : "[APNS]";

  // Only check manual disable flag (not failure count)
  if (client.device.disabled) {
    req.log.warn(
      { deviceId: client.deviceId, pushTokenType: pushType },
      `${tag} Device is manually disabled. Skipping notification.`,
    );
    return { success: false };
  }

  // Log warning if high failure count but don't block
  if (client.device.pushFailures >= MAX_PUSH_FAILURES) {
    req.log.warn(
      {
        deviceId: client.deviceId,
        pushTokenType: pushType,
        failures: client.device.pushFailures,
        lastFailureAt: client.device.lastFailureAt,
      },
      `${tag} Device has high failure count (${client.device.pushFailures}) but continuing`,
    );
  }

  // Generate JWT for NSE (Notification Service Extension) to use
  // 12h expiry because NSE cannot generate App Attest tokens and needs a valid JWT
  // to authenticate with the Payer Gateway when connecting to the XMTP d14n network
  const apiJWT = await createJwtToken({
    deviceId: client.deviceId,
    expirationTime: "12h",
    metadata: {
      notificationExtensionOnly: true,
    },
  });

  // Check if this is a welcome message (too large for push payload limit)
  // Both APNS and FCM have a 4KB limit
  const isWelcome = isWelcomeMessage({
    contentTopic: notification.message.content_topic,
    messageType: notification.message_context.message_type,
  });

  if (isWelcome) {
    req.log.info(
      {
        contentTopic: notification.message.content_topic,
        pushTokenType: pushType,
      },
      `${tag} Detected welcome message – omitting encrypted content to avoid payload limit`,
    );
  }

  // Build notification payload (same for both APNS and FCM)
  const v2Notification: V2NotificationPayload = {
    clientId: notification.installation.id,
    apiJWT,
    notificationType: "Protocol",
    notificationData: {
      contentTopic: notification.message.content_topic,
      messageType: notification.message_context.message_type,
      // Omit encryptedMessage for welcome messages (too large for 4KB limit)
      ...(isWelcome ? {} : { encryptedMessage: notification.message.message }),
      timestamp: notification.message.timestamp_ns,
    },
  };

  // Proactive payload size guard.
  // Reuses existing JSON.stringify measurement already used in service-level logs.
  const maxBytes =
    pushType === "fcm" ? FCM_MAX_PAYLOAD_BYTES : APNS_MAX_PAYLOAD_BYTES;
  const stripThreshold = maxBytes - PUSH_PAYLOAD_STRIP_MARGIN_BYTES;
  const fullSize = JSON.stringify(v2Notification).length;

  let payloadStripped = false;
  if (fullSize > stripThreshold && !isWelcome) {
    v2Notification.notificationData = {
      contentTopic: notification.message.content_topic,
      messageType: notification.message_context.message_type,
      timestamp: notification.message.timestamp_ns,
      // encryptedMessage omitted
    };
    payloadStripped = true;
    req.log.warn(
      {
        deviceId: client.deviceId,
        pushTokenType: pushType,
        contentTopic: notification.message.content_topic,
        messageType: notification.message_context.message_type,
        fullSize,
        stripThreshold,
        maxBytes,
      },
      `${tag} Payload exceeds strip threshold – omitting encryptedMessage`,
    );
  }

  // Route to appropriate push service based on token type
  let result: { success: boolean; error?: string };

  req.log.info(
    {
      deviceId: client.deviceId,
      pushTokenType: pushType,
      contentTopic: notification.message.content_topic,
      messageType: notification.message_context.message_type,
      isWelcome,
      payloadSize: JSON.stringify(v2Notification.notificationData).length,
    },
    `${tag} Routing push notification to ${pushType} service`,
  );

  if (pushType === "fcm") {
    // Android/FCM push notification
    const fcmService = createFcmService();
    if (!fcmService) {
      req.log.error(
        { deviceId: client.deviceId },
        "[FCM] Service not configured – cannot send push",
      );
      return { success: false };
    }

    result = await fcmService.sendPushNotification({
      device: {
        id: client.deviceId,
        pushToken: client.device.pushToken,
        pushTokenType: client.device.pushTokenType,
      },
      notification: {
        ...v2Notification,
        notificationData: { ...v2Notification.notificationData },
      },
    });
  } else {
    // iOS/APNS push notification
    const apnsService = createApnsService();
    if (!apnsService) {
      req.log.error(
        { deviceId: client.deviceId },
        "[APNS] Service not configured – cannot send push",
      );
      return { success: false };
    }

    result = await apnsService.sendPushNotification({
      device: {
        id: client.deviceId,
        pushToken: client.device.pushToken,
        pushTokenType: client.device.pushTokenType,
        apnsEnv: client.device.apnsEnv,
      },
      notification: {
        ...v2Notification,
        notificationData: { ...v2Notification.notificationData },
      },
    });
  }

  // Reactive PayloadTooLarge handling: strip + retry once, do NOT bump pushFailures.
  if (!result.success && result.error === "PayloadTooLarge") {
    if (payloadStripped) {
      req.log.error(
        {
          deviceId: client.deviceId,
          pushTokenType: pushType,
          contentTopic: notification.message.content_topic,
          fullSize,
          stripThreshold,
        },
        `${tag} PayloadTooLarge on already-stripped payload – investigate`,
      );
      return { success: false, error: result.error };
    }

    req.log.warn(
      {
        deviceId: client.deviceId,
        pushTokenType: pushType,
        contentTopic: notification.message.content_topic,
        fullSize,
        stripThreshold,
      },
      `${tag} PayloadTooLarge after proactive guard – retrying stripped`,
    );

    v2Notification.notificationData = {
      contentTopic: notification.message.content_topic,
      messageType: notification.message_context.message_type,
      timestamp: notification.message.timestamp_ns,
    };
    payloadStripped = true;

    if (pushType === "fcm") {
      const fcmService = createFcmService();
      if (!fcmService) {
        return { success: false, error: "FCM service unavailable on retry" };
      }
      result = await fcmService.sendPushNotification({
        device: {
          id: client.deviceId,
          pushToken: client.device.pushToken,
          pushTokenType: client.device.pushTokenType,
        },
        notification: v2Notification,
      });
    } else {
      const apnsService = createApnsService();
      if (!apnsService) {
        return { success: false, error: "APNS service unavailable on retry" };
      }
      result = await apnsService.sendPushNotification({
        device: {
          id: client.deviceId,
          pushToken: client.device.pushToken,
          pushTokenType: client.device.pushTokenType,
          apnsEnv: client.device.apnsEnv,
        },
        notification: v2Notification,
      });
    }

    if (!result.success) {
      req.log.error(
        {
          deviceId: client.deviceId,
          error: result.error,
          pushTokenType: pushType,
        },
        `${tag} PayloadTooLarge retry failed`,
      );
      // Server-side issue; do NOT bump pushFailures.
      return { success: false, error: result.error };
    }
    // Retry succeeded — fall through to existing success path below.
  }

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
      {
        deviceId: client.deviceId,
        pushTokenType: pushType,
        contentTopic: notification.message.content_topic,
      },
      `${tag} Successfully sent v2 push notification`,
    );
  } else {
    // Increment failures and conditionally disable in XMTP production environment
    let autoDisabled = false;

    const updated = await prisma.$transaction(async (tx) => {
      const u = await tx.deviceRegistration.update({
        where: { deviceId: client.deviceId },
        data: {
          pushFailures: { increment: 1 },
          lastFailureAt: new Date(),
        },
      });

      // Auto-disable in XMTP production only to preserve test devices in dev/staging for debugging
      if (
        process.env.XMTP_ENV === "production" &&
        u.pushFailures >= MAX_PUSH_FAILURES
      ) {
        await tx.deviceRegistration.updateMany({
          where: {
            deviceId: client.deviceId,
            disabled: false,
          },
          data: { disabled: true },
        });
        autoDisabled = true;
      }

      return u;
    });

    // Log detailed error information
    const rawToken = client.device.pushToken ?? "";
    const maskedToken =
      rawToken.length > 16
        ? `${rawToken.slice(0, 8)}...${rawToken.slice(-4)} (len=${rawToken.length})`
        : rawToken.length > 0
          ? `${rawToken.slice(0, 4)}...${rawToken.slice(-4)}`
          : "(none)";
    req.log.error(
      {
        deviceId: client.deviceId,
        error: result.error,
        failureCount: updated.pushFailures,
        pushTokenType: pushType,
        pushTokenMasked: maskedToken,
        apnsEnv: client.device.apnsEnv,
        lastFailureAt: updated.lastFailureAt,
        autoDisabled,
        contentTopic: notification.message.content_topic,
        messageType: notification.message_context.message_type,
      },
      `${tag} Failed to send v2 push notification: ${result.error}`,
    );

    // Cleanup if unrecoverable error
    if (
      result.error === "DeviceNotRegistered" ||
      result.error === "BadDeviceToken"
    ) {
      req.log.info(
        { clientId: client.id, error: result.error, pushTokenType: pushType },
        `${tag} Cleaning up v2 notification client due to unrecoverable error`,
      );
      try {
        // Delete from local DB first to ensure we don't retry on failure
        await prisma.clientIdentifier.delete({
          where: { id: client.id },
        });

        // Then attempt notification server cleanup
        try {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-call
          await notificationClient.deleteInstallation({
            installationId: client.id,
          });
        } catch (xmtpError) {
          // Log but don't fail - DB is authoritative, orphaned XMTP installation is harmless
          req.log.warn(
            { error: xmtpError, clientId: client.id },
            `${tag} Failed to delete XMTP installation, but local DB is clean`,
          );
        }

        req.log.info(
          { clientId: client.id, pushTokenType: pushType },
          `${tag} Successfully cleaned up v2 notifications`,
        );
      } catch (cleanupError) {
        req.log.error(
          { error: cleanupError, clientId: client.id },
          `${tag} Failed to cleanup v2 notification subscriptions after push failure`,
        );
        // Don't throw here - this is already in error handling path
      }
    }
  }

  return result;
}
