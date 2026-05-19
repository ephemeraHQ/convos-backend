import { describe, expect, mock, test } from "bun:test";

const sendMock = mock(() => Promise.resolve("ignored"));

void mock.module("firebase-admin/messaging", () => ({
  getMessaging: () => ({ send: sendMock }),
}));
void mock.module("@/utils/firebase", () => ({
  getFirebaseApp: () => ({}),
}));

const { FcmPushService } = await import(
  "@/api/v2/notifications/fcm-push.service"
);

describe("FcmPushService – PayloadTooLarge classification", () => {
  const service = new FcmPushService();
  const device = {
    id: "dev-fcm-1",
    pushToken: "fcm-token-abc",
    pushTokenType: "fcm" as const,
  };
  const notification = {
    clientId: "client-1",
    apiJWT: "jwt",
    notificationType: "Protocol" as const,
    notificationData: {
      contentTopic: "/xmtp/mls/1/g-test/proto",
      messageType: "v3-application",
      encryptedMessage: "abc",
      timestamp: "1700000000000000000",
    },
  };

  test("FCM code=messaging/payload-size-limit-exceeded maps to error='PayloadTooLarge'", async () => {
    sendMock.mockImplementationOnce(() => {
      const err = new Error("Payload too large") as Error & { code: string };
      err.code = "messaging/payload-size-limit-exceeded";
      throw err;
    });
    const result = await service.sendPushNotification({ device, notification });
    expect(result.success).toBe(false);
    expect(result.error).toBe("PayloadTooLarge");
  });

  test("FCM code=registration-token-not-registered maps to BadDeviceToken (regression)", async () => {
    sendMock.mockImplementationOnce(() => {
      const err = new Error("not registered") as Error & { code: string };
      err.code = "messaging/registration-token-not-registered";
      throw err;
    });
    const result = await service.sendPushNotification({ device, notification });
    expect(result.success).toBe(false);
    expect(result.error).toBe("BadDeviceToken");
  });
});
