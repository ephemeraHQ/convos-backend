import type { PushTokenType } from "@prisma/client";
import { getMessaging, type Messaging } from "firebase-admin/messaging";
import { getFirebaseApp } from "@/utils/firebase";
import logger from "@/utils/logger";
import type { AnyNotificationPayloadWithJWT } from "./types";

export interface FcmDevice {
  id: string;
  pushToken: string | null;
  pushTokenType: PushTokenType;
}

export class FcmPushService {
  private messaging: Messaging;

  constructor() {
    const app = getFirebaseApp();
    this.messaging = getMessaging(app);
  }

  async sendPushNotification(args: {
    device: FcmDevice;
    notification: AnyNotificationPayloadWithJWT;
    isSilent?: boolean;
  }): Promise<{ success: boolean; error?: string }> {
    const { device, notification, isSilent } = args;

    if (!device.pushToken) {
      return { success: false, error: "No FCM push token available" };
    }

    if (device.pushTokenType !== "fcm") {
      return { success: false, error: "Device is not configured for FCM" };
    }

    let notificationData: string;
    try {
      notificationData = JSON.stringify(notification.notificationData);
    } catch (error) {
      logger.error(
        {
          deviceId: device.id,
          error,
          verbose: true,
        },
        "[VERBOSE] Failed to serialize notification data",
      );
      return { success: false, error: "Invalid notification data" };
    }

    // FCM data messages - all values must be strings
    // Data-only messages are always delivered to onMessageReceived() on Android
    // even when the app is in background, allowing proper handling
    const data: Record<string, string> = {
      apiJWT: notification.apiJWT,
      notificationType: notification.notificationType,
      notificationData,
    };

    // Add clientId or inboxId depending on which is present
    if ("clientId" in notification && notification.clientId) {
      data.clientId = notification.clientId;
    } else if ("inboxId" in notification && notification.inboxId) {
      data.inboxId = notification.inboxId;
    }

    try {
      logger.info(
        {
          deviceId: device.id,
          isSilent,
          verbose: true,
        },
        "[VERBOSE] Sending FCM push notification",
      );

      const messageId = await this.messaging.send({
        token: device.pushToken,
        data,
        android: {
          // High priority ensures immediate delivery
          priority: isSilent ? "normal" : "high",
        },
      });

      logger.info(
        {
          deviceId: device.id,
          messageId,
          verbose: true,
        },
        "[VERBOSE] FCM push notification sent successfully",
      );

      return { success: true };
    } catch (error) {
      const fcmError = error as Error & { code?: string };

      logger.error(
        {
          deviceId: device.id,
          error: fcmError.message,
          code: fcmError.code,
          verbose: true,
        },
        "[VERBOSE] FCM push notification failed",
      );

      // Map FCM error codes to consistent error responses
      if (
        fcmError.code === "messaging/registration-token-not-registered" ||
        fcmError.code === "messaging/invalid-registration-token"
      ) {
        return { success: false, error: "BadDeviceToken" };
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
      "FIREBASE_SERVICE_ACCOUNT not set, FCM push notifications disabled",
    );
    return null;
  }

  try {
    cachedFcmService = new FcmPushService();
    return cachedFcmService;
  } catch (error) {
    logger.warn({ error }, "Failed to initialize FCM service");
    return null;
  }
}
