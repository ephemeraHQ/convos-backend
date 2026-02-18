import { describe, expect, test } from "bun:test";
import {
  createFcmService,
  FcmPushService,
} from "@/api/v2/notifications/fcm-push.service";
import type { V2NotificationPayload } from "@/api/v2/notifications/types";

const mockNotification: V2NotificationPayload = {
  clientId: "test-client-123",
  apiJWT: "test-jwt-token",
  notificationType: "Protocol",
  notificationData: {
    contentTopic: "/xmtp/test",
    messageType: "v3-message",
    encryptedMessage: "encrypted-content",
    timestamp: "1234567890",
  },
};

describe("FcmPushService", () => {
  describe("createFcmService", () => {
    test("should create a service instance when FIREBASE_SERVICE_ACCOUNT is set", () => {
      const service = createFcmService();
      expect(service).toBeInstanceOf(FcmPushService);
    });

    test("should return cached instance on subsequent calls", () => {
      const service1 = createFcmService();
      const service2 = createFcmService();
      expect(service1).toBe(service2);
    });
  });

  describe("sendPushNotification", () => {
    test("should return error when push token is null", async () => {
      const service = createFcmService();
      expect(service).not.toBeNull();

      const result = await service!.sendPushNotification({
        device: {
          id: "device-123",
          pushToken: null,
          pushTokenType: "fcm",
        },
        notification: mockNotification,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe("No FCM push token available");
    });

    test("should return error when device is not configured for FCM", async () => {
      const service = createFcmService();
      expect(service).not.toBeNull();

      const result = await service!.sendPushNotification({
        device: {
          id: "device-123",
          pushToken: "some-token",
          pushTokenType: "apns",
        },
        notification: mockNotification,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe("Device is not configured for FCM");
    });

    test("should send push notification successfully with valid FCM token", async () => {
      const service = createFcmService();
      expect(service).not.toBeNull();

      const result = await service!.sendPushNotification({
        device: {
          id: "device-123",
          pushToken: "valid-fcm-token",
          pushTokenType: "fcm",
        },
        notification: mockNotification,
      });

      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
    });

    test("should return BadDeviceToken error for invalid FCM token", async () => {
      const service = createFcmService();
      expect(service).not.toBeNull();

      const result = await service!.sendPushNotification({
        device: {
          id: "device-123",
          pushToken: "invalid-fcm-token",
          pushTokenType: "fcm",
        },
        notification: mockNotification,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe("BadDeviceToken");
    });

    test("should handle silent notifications", async () => {
      const service = createFcmService();
      expect(service).not.toBeNull();

      const result = await service!.sendPushNotification({
        device: {
          id: "device-123",
          pushToken: "valid-fcm-token",
          pushTokenType: "fcm",
        },
        notification: mockNotification,
        isSilent: true,
      });

      expect(result.success).toBe(true);
    });

    test("should return error when notification data cannot be serialized", async () => {
      const service = createFcmService();
      expect(service).not.toBeNull();

      const result = await service!.sendPushNotification({
        device: {
          id: "device-123",
          pushToken: "valid-fcm-token",
          pushTokenType: "fcm",
        },
        notification: {
          ...mockNotification,
          notificationData: { bad: BigInt(1) } as never,
        },
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe("Invalid notification data");
    });
  });
});
