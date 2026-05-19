import type { PushTokenType } from "@prisma/client";
import type { ServiceAccount } from "firebase-admin/app";
import { getMessaging, type Messaging } from "firebase-admin/messaging";
import { getFirebaseApp } from "@/utils/firebase";
import logger from "@/utils/logger";
import type { AnyNotificationPayloadWithJWT } from "./types";

export interface FcmDevice {
  id: string;
  pushToken: string | null;
  pushTokenType: PushTokenType;
}

/** Mask a token for safe logging: show first 8 and last 4 chars */
function maskToken(token: string): string {
  if (token.length <= 16) return `${token.slice(0, 4)}...${token.slice(-4)}`;
  return `${token.slice(0, 8)}...${token.slice(-4)} (len=${token.length})`;
}

/**
 * Build the FCM message body for size measurement.
 * This is the object Firebase counts against the 4096-byte FCM limit (excluding token routing field).
 * Exported so the handler can size-check before dispatch using identical shape.
 *
 * Note: `data` values must all be strings per FCM contract (notificationData is JSON-stringified inline).
 */
export function buildFcmWirePayload(args: {
  notification: AnyNotificationPayloadWithJWT;
  isSilent: boolean;
}): {
  data: Record<string, string>;
  android: { priority: "normal" | "high" };
} {
  const { notification, isSilent } = args;
  const data: Record<string, string> = {
    apiJWT: notification.apiJWT,
    notificationType: notification.notificationType,
    notificationData: JSON.stringify(notification.notificationData),
  };
  // Add clientId or inboxId
  if ("clientId" in notification && notification.clientId) {
    data.clientId = notification.clientId;
  } else if ("inboxId" in notification && notification.inboxId) {
    data.inboxId = notification.inboxId;
  }
  return {
    data,
    android: { priority: isSilent ? "normal" : "high" },
  };
}

export class FcmPushService {
  private messaging: Messaging;
  /** Firebase project ID extracted from the service account (for diagnostics) */
  private projectId: string | undefined;
  /** Service account email (for diagnostics) */
  private serviceAccountEmail: string | undefined;

  constructor() {
    const app = getFirebaseApp();
    this.messaging = getMessaging(app);

    // Extract project metadata from service account for diagnostic logging
    try {
      const sa = JSON.parse(
        process.env.FIREBASE_SERVICE_ACCOUNT ?? "{}",
      ) as ServiceAccount;
      this.projectId = sa.projectId;
      this.serviceAccountEmail = sa.clientEmail;
    } catch {
      // Non-critical – just for logging
    }
  }

  async sendPushNotification(args: {
    device: FcmDevice;
    notification: AnyNotificationPayloadWithJWT;
    isSilent?: boolean;
  }): Promise<{ success: boolean; error?: string }> {
    const { device, notification, isSilent } = args;

    if (!device.pushToken) {
      logger.warn(
        { deviceId: device.id },
        "[FCM] No push token available – skipping send",
      );
      return { success: false, error: "No FCM push token available" };
    }

    if (device.pushTokenType !== "fcm") {
      logger.warn(
        { deviceId: device.id, pushTokenType: device.pushTokenType },
        "[FCM] Device push token type mismatch – expected 'fcm'",
      );
      return { success: false, error: "Device is not configured for FCM" };
    }

    // Extract content topic for logging (if Protocol notification)
    // Safe: notificationData is a JSON-deserialized object from the webhook (already zod-validated).
    const contentTopic =
      "contentTopic" in notification.notificationData
        ? (notification.notificationData as { contentTopic?: string })
            .contentTopic
        : undefined;

    // FCM data messages - all values must be strings.
    // Data-only messages are always delivered to onMessageReceived() on Android
    // even when the app is in background, allowing proper handling.
    // Build payload in its own try so JSON.stringify failures (BigInt, circular refs)
    // map to the specific "Invalid notification data" error rather than leaking the
    // raw Error.message through the generic catch below.
    let wirePayload: ReturnType<typeof buildFcmWirePayload>;
    try {
      wirePayload = buildFcmWirePayload({
        notification,
        isSilent: !!isSilent,
      });
    } catch (error) {
      logger.error(
        { deviceId: device.id, error },
        "[FCM] Failed to serialize notification data",
      );
      return { success: false, error: "Invalid notification data" };
    }

    try {
      const { data } = wirePayload;

      // Derive identifierType for logging
      const identifierType =
        "clientId" in data
          ? "clientId"
          : "inboxId" in data
            ? "inboxId"
            : undefined;

      logger.info(
        {
          deviceId: device.id,
          pushTokenMasked: maskToken(device.pushToken),
          isSilent,
          notificationType: notification.notificationType,
          identifierType,
          contentTopic,
          firebaseProject: this.projectId,
          payloadSize: Buffer.byteLength(JSON.stringify(wirePayload), "utf8"),
        },
        "[FCM] Sending push notification",
      );

      const messageId = await this.messaging.send({
        token: device.pushToken,
        ...wirePayload,
      });

      logger.info(
        {
          deviceId: device.id,
          messageId,
          pushTokenMasked: maskToken(device.pushToken),
          firebaseProject: this.projectId,
        },
        "[FCM] Push notification sent successfully",
      );

      return { success: true };
    } catch (error) {
      const fcmError = error as Error & {
        code?: string;
        details?: unknown;
        errorInfo?: Record<string, unknown>;
      };

      logger.error(
        {
          deviceId: device.id,
          pushTokenMasked: maskToken(device.pushToken),
          error: fcmError.message,
          code: fcmError.code,
          errorInfo: fcmError.errorInfo,
          firebaseProject: this.projectId,
          serviceAccountEmail: this.serviceAccountEmail,
          notificationType: notification.notificationType,
          contentTopic,
        },
        "[FCM] Push notification failed",
      );

      // Emit a targeted diagnostic for IAM permission errors so the fix is obvious in logs
      const isIamError =
        fcmError.message.includes("cloudmessaging.messages.create") ||
        fcmError.message.includes("PERMISSION_DENIED") ||
        (fcmError.message.includes("Permission") &&
          fcmError.message.includes("denied"));
      if (isIamError) {
        logger.error(
          {
            serviceAccountEmail: this.serviceAccountEmail,
            firebaseProject: this.projectId,
            requiredRole: "roles/cloudmessaging.admin",
            gcloudFix: `gcloud projects add-iam-policy-binding ${this.projectId} --member="serviceAccount:${this.serviceAccountEmail}" --role="roles/cloudmessaging.admin"`,
          },
          "[FCM] IAM PERMISSION DENIED – service account is missing cloudmessaging.messages.create. Grant roles/cloudmessaging.admin (see gcloudFix field)",
        );
      }

      // Map FCM error codes to consistent error responses
      if (
        fcmError.code === "messaging/registration-token-not-registered" ||
        fcmError.code === "messaging/invalid-registration-token"
      ) {
        return { success: false, error: "BadDeviceToken" };
      }

      if (fcmError.code === "messaging/payload-size-limit-exceeded") {
        return { success: false, error: "PayloadTooLarge" };
      }

      return { success: false, error: fcmError.message || "Unknown FCM error" };
    }
  }
}

// Cached FCM service instance
let cachedFcmService: FcmPushService | null = null;
let fcmServiceInitialized = false;

// Factory function to create or return cached FCM service
export function createFcmService(): FcmPushService | null {
  if (fcmServiceInitialized) {
    return cachedFcmService;
  }

  fcmServiceInitialized = true;

  if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
    logger.warn(
      "[FCM] FIREBASE_SERVICE_ACCOUNT not set, FCM push notifications disabled",
    );
    return null;
  }

  try {
    // Log which Firebase project we're initialising against
    const sa = JSON.parse(
      process.env.FIREBASE_SERVICE_ACCOUNT,
    ) as ServiceAccount;
    logger.info(
      {
        firebaseProject: sa.projectId,
        serviceAccountEmail: sa.clientEmail,
      },
      "[FCM] Initialising FCM service",
    );

    cachedFcmService = new FcmPushService();
    return cachedFcmService;
  } catch (error) {
    logger.warn({ error }, "[FCM] Failed to initialize FCM service");
    return null;
  }
}
