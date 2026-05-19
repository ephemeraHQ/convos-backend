import { describe, expect, mock, test } from "bun:test";
import type { ApnsDevice } from "@/api/v2/notifications/apns-push.service";

type EventListener = (...args: unknown[]) => void;

class FakeClient {
  private listeners = new Map<string, EventListener[]>();
  on(event: string, fn: EventListener) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event)!.push(fn);
  }
  emit(event: string, ...args: unknown[]) {
    for (const fn of this.listeners.get(event) ?? []) fn(...args);
  }
  request() {
    return new FakeRequest(this);
  }
  close() {}
}

class FakeRequest {
  private listeners = new Map<string, EventListener[]>();
  constructor(public client: FakeClient) {}
  on(event: string, fn: EventListener) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event)!.push(fn);
  }
  emit(event: string, ...args: unknown[]) {
    for (const fn of this.listeners.get(event) ?? []) fn(...args);
  }
  write(_: string) {}
  end() {
    // Simulate APNS response asynchronously
    queueMicrotask(() => {
      this.emit("response", {
        ":status":
          (globalThis as { __apnsTestStatus?: number }).__apnsTestStatus ?? 413,
        "apns-id": "test-apns-id",
      });
      this.emit(
        "data",
        Buffer.from(JSON.stringify({ reason: "PayloadTooLarge" })),
      );
      this.emit("end");
    });
  }
}

let fakeClient: FakeClient;

void mock.module("node:http2", () => ({
  default: {
    connect: () => {
      fakeClient = new FakeClient();
      return fakeClient;
    },
  },
  connect: () => {
    fakeClient = new FakeClient();
    return fakeClient;
  },
}));

// Import AFTER mock.module so service picks up stubbed http2
const { ApnsPushService } = await import(
  "@/api/v2/notifications/apns-push.service"
);

const ES256_TEST_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgevZzL1gdAFr88hb2
OF/2NxApJCzGCEDdfSp6VQO30hyhRANCAAQRWz+jn65BtOMvdyHKcvjBeBSDZH2r
1RTwjmYSi9R/zpBnuQ4EiMnCqfMPWiZqB4QdbAd0E7oH50VpuZ1P087G
-----END PRIVATE KEY-----`;

describe("ApnsPushService – PayloadTooLarge classification", () => {
  const service = new ApnsPushService({
    teamId: "TESTTEAM",
    keyId: "TESTKEY",
    privateKey: ES256_TEST_KEY,
    bundleId: "com.test.app",
  });

  const device: ApnsDevice = {
    id: "dev-test",
    pushToken: "a".repeat(64),
    pushTokenType: "apns",
    apnsEnv: "sandbox",
  };

  test("HTTP 413 with reason=PayloadTooLarge maps to error='PayloadTooLarge'", async () => {
    (globalThis as { __apnsTestStatus?: number }).__apnsTestStatus = 413;
    const result = await service.sendPushNotification({
      device,
      notification: {
        clientId: "client-1",
        apiJWT: "jwt",
        notificationType: "Protocol",
        notificationData: {
          contentTopic: "/xmtp/mls/1/g-test/proto",
          messageType: "v3-application",
          encryptedMessage: "abc",
          timestamp: "1700000000000000000",
        },
      },
    });
    expect(result.success).toBe(false);
    expect(result.error).toBe("PayloadTooLarge");
  });

  test("HTTP 410 still maps to BadDeviceToken (regression)", async () => {
    (globalThis as { __apnsTestStatus?: number }).__apnsTestStatus = 410;
    const result = await service.sendPushNotification({
      device,
      notification: {
        clientId: "client-2",
        apiJWT: "jwt",
        notificationType: "Protocol",
        notificationData: {
          contentTopic: "/xmtp/mls/1/g-test/proto",
          messageType: "v3-application",
          encryptedMessage: "abc",
          timestamp: "1700000000000000000",
        },
      },
    });
    expect(result.success).toBe(false);
    expect(result.error).toBe("BadDeviceToken");
  });
});
