import type { ClientIdentifier, DeviceRegistration } from "@prisma/client";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { Request } from "express";

// ---- Mocks (must be installed BEFORE importing the SUT) ----

const apnsSendMock = mock(() =>
  Promise.resolve({ success: true } as { success: boolean; error?: string }),
);
const fcmSendMock = mock(() =>
  Promise.resolve({ success: true } as { success: boolean; error?: string }),
);

void mock.module("@/api/v2/notifications/apns-push.service", () => ({
  createApnsService: () => ({ sendPushNotification: apnsSendMock }),
  buildApnsWirePayload: (args: {
    notification: {
      apiJWT: string;
      notificationType: string;
      notificationData: Record<string, unknown>;
      clientId?: string;
    };
    isSilent: boolean;
  }) => ({
    aps: {
      alert: { body: "New message" },
      sound: "default",
      "mutable-content": 1,
    },
    ...args.notification,
  }),
}));
void mock.module("@/api/v2/notifications/fcm-push.service", () => {
  // Singleton instance cache — mirrors the real createFcmService() caching behaviour
  // so that fcm-push.test.ts's "should return cached instance" assertion passes.
  let instance: FcmPushService | null = null;

  // Token-routing stub that mirrors the preload firebase-admin/messaging mock.
  // Special tokens exercise specific code paths (used by fcm-push.test.ts).
  // Any other token falls through to fcmSendMock (used by notifications-payload-guard.test.ts).
  class FcmPushService {
    async sendPushNotification(args: {
      device: {
        id: string;
        pushToken: string | null;
        pushTokenType: string;
      };
      notification: {
        notificationData: Record<string, unknown>;
      };
      isSilent?: boolean;
    }): Promise<{ success: boolean; error?: string }> {
      const { device, notification } = args;

      if (!device.pushToken) {
        return { success: false, error: "No FCM push token available" };
      }
      if (device.pushTokenType !== "fcm") {
        return { success: false, error: "Device is not configured for FCM" };
      }

      // Validate notification data is serializable
      try {
        JSON.stringify(notification.notificationData);
      } catch {
        return { success: false, error: "Invalid notification data" };
      }

      // Token-based routing (matches preload firebase mock + new trigger token)
      if (device.pushToken === "valid-fcm-token") {
        return { success: true };
      }
      if (device.pushToken === "trigger-payload-size-limit") {
        return { success: false, error: "PayloadTooLarge" };
      }
      if (device.pushToken === "invalid-fcm-token") {
        return { success: false, error: "BadDeviceToken" };
      }

      // All other tokens: delegate to fcmSendMock (lets webhook tests inject
      // custom responses via mockImplementationOnce).
      return (
        fcmSendMock as unknown as (
          a: typeof args,
        ) => Promise<{ success: boolean; error?: string }>
      )(args);
    }
  }

  return {
    createFcmService: () => {
      if (!instance) instance = new FcmPushService();
      return instance;
    },
    FcmPushService,
    buildFcmWirePayload: (args: {
      notification: {
        apiJWT: string;
        notificationType: string;
        notificationData: Record<string, unknown>;
        clientId?: string;
      };
      isSilent: boolean;
    }) => {
      const data: Record<string, string> = {
        apiJWT: args.notification.apiJWT,
        notificationType: args.notification.notificationType,
        notificationData: JSON.stringify(args.notification.notificationData),
      };
      if (args.notification.clientId)
        data.clientId = args.notification.clientId;
      return { data, android: { priority: args.isSilent ? "normal" : "high" } };
    },
  };
});

const deviceUpdateMock = mock(() =>
  Promise.resolve({ pushFailures: 0, lastFailureAt: null }),
);
const deviceTxMock = mock(() =>
  Promise.resolve({ pushFailures: 1, lastFailureAt: new Date() }),
);
const clientDeleteMock = mock(() => Promise.resolve());
const txMock = mock(async (fn: (tx: unknown) => Promise<unknown>) =>
  fn({
    deviceRegistration: {
      update: deviceTxMock,
      updateMany: mock(() => Promise.resolve()),
    },
  }),
);

void mock.module("@/utils/prisma", () => ({
  prisma: {
    deviceRegistration: { update: deviceUpdateMock },
    clientIdentifier: { delete: clientDeleteMock },
    $transaction: txMock,
  },
}));

void mock.module("@/notifications/client", () => ({
  createNotificationClient: () => ({
    deleteInstallation: mock(() => Promise.resolve()),
  }),
  webhookNotificationBodySchema: {
    safeParse: () => ({ success: true, data: {} }),
  },
}));

void mock.module("@/utils/jwt", () => ({
  createJwtToken: () =>
    Promise.resolve(
      "eyJhbGciOiJFUzI1NiIsImtpZCI6InRlc3Qta2lkLTAxIiwidHlwIjoiSldUIn0." +
        "x".repeat(280) +
        ".sig-placeholder",
    ),
}));

const { handleV2Notification } = await import(
  "@/api/v2/notifications/handlers/webhook"
);

// ---- Test helpers ----

type LogLine = { level: string; obj: Record<string, unknown>; msg: string };
type SendCall = {
  notification: { notificationData: { encryptedMessage?: string } };
};

function makeReq(): Request & { capturedLogs: LogLine[] } {
  const capturedLogs: LogLine[] = [];
  const log = {
    info: (obj: Record<string, unknown>, msg: string) =>
      capturedLogs.push({ level: "info", obj, msg }),
    warn: (obj: Record<string, unknown>, msg: string) =>
      capturedLogs.push({ level: "warn", obj, msg }),
    error: (obj: Record<string, unknown>, msg: string) =>
      capturedLogs.push({ level: "error", obj, msg }),
  };
  return { log, capturedLogs } as unknown as Request & {
    capturedLogs: LogLine[];
  };
}

function makeClient(pushType: "apns" | "fcm"): ClientIdentifier & {
  device: DeviceRegistration;
} {
  return {
    id: "client-1",
    deviceId: "dev-1",
    addedAt: new Date(),
    updatedAt: new Date(),
    device: {
      deviceId: "dev-1",
      accountId: null,
      pushToken: "tok-" + "a".repeat(60),
      pushTokenType: pushType,
      apnsEnv: pushType === "apns" ? "sandbox" : null,
      disabled: false,
      pushFailures: 0,
      lastFailureAt: null,
      lastSentAt: null,
      addedAt: new Date(),
      updatedAt: new Date(),
    } as unknown as DeviceRegistration,
  } as unknown as ClientIdentifier & { device: DeviceRegistration };
}

function makeWebhook(args: {
  contentTopic?: string;
  messageType?: string;
  encryptedMessageLen?: number;
}) {
  return {
    idempotency_key: "idem-1",
    installation: {
      id: "install-1",
      delivery_mechanism: { kind: "apns", token: "tok-1" },
    },
    message: {
      content_topic: args.contentTopic ?? "/xmtp/mls/1/g-real/proto",
      message_type: args.messageType ?? "v3-application",
      message: "x".repeat(args.encryptedMessageLen ?? 100),
      timestamp_ns: "1700000000000000000",
    },
    message_context: {
      message_type: args.messageType ?? "v3-application",
    },
    subscription: {
      created_at: "2024-01-01T00:00:00Z",
      topic: args.contentTopic ?? "/xmtp/mls/1/g-real/proto",
      is_silent: false,
    },
  };
}

beforeEach(() => {
  apnsSendMock.mockClear();
  fcmSendMock.mockClear();
  deviceUpdateMock.mockClear();
  deviceTxMock.mockClear();
});

// ---- Tests ----

describe("handleV2Notification – proactive size guard", () => {
  test("APNS: oversize encryptedMessage is stripped before dispatch", async () => {
    // 4000 chars >> 3800 threshold once wrapped in JSON envelope
    const webhook = makeWebhook({ encryptedMessageLen: 4000 });
    const client = makeClient("apns");
    const req = makeReq();

    await handleV2Notification({ notification: webhook, client, req });

    expect(apnsSendMock).toHaveBeenCalledTimes(1);
    const apnsCalls = apnsSendMock.mock.calls as unknown[][];
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
    const dispatched = (apnsCalls[0]![0] as SendCall).notification;
    expect(dispatched.notificationData.encryptedMessage).toBeUndefined();

    const stripLog = req.capturedLogs.find((l) =>
      l.msg.includes("Payload exceeds strip threshold"),
    );
    expect(stripLog).toBeDefined();
    expect(stripLog?.level).toBe("info");
  });

  test("FCM: oversize encryptedMessage is stripped before dispatch", async () => {
    const webhook = makeWebhook({ encryptedMessageLen: 4000 });
    const client = makeClient("fcm");
    const req = makeReq();

    await handleV2Notification({ notification: webhook, client, req });

    expect(fcmSendMock).toHaveBeenCalledTimes(1);
    const fcmCalls = fcmSendMock.mock.calls as unknown[][];
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
    const dispatched = (fcmCalls[0]![0] as SendCall).notification;
    expect(dispatched.notificationData.encryptedMessage).toBeUndefined();
  });

  test("Under-threshold payload is NOT stripped", async () => {
    const webhook = makeWebhook({ encryptedMessageLen: 100 });
    const client = makeClient("apns");
    const req = makeReq();

    await handleV2Notification({ notification: webhook, client, req });

    expect(apnsSendMock).toHaveBeenCalledTimes(1);
    const apnsCallsUnder = apnsSendMock.mock.calls as unknown[][];
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
    const dispatched = (apnsCallsUnder[0]![0] as SendCall).notification;
    expect(dispatched.notificationData.encryptedMessage).toBeDefined();

    const stripLog = req.capturedLogs.find((l) =>
      l.msg.includes("Payload exceeds strip threshold"),
    );
    expect(stripLog).toBeUndefined();
  });

  test("Boundary: payload at threshold-1 NOT stripped; at threshold+1 IS stripped", async () => {
    // Binary-search the encryptedMessage length that lands at the strip boundary.
    let underLen = 100;
    let overLen = 5000;
    while (overLen - underLen > 2) {
      apnsSendMock.mockClear();
      const mid = Math.floor((underLen + overLen) / 2);
      const webhook = makeWebhook({ encryptedMessageLen: mid });
      const client = makeClient("apns");
      const req = makeReq();
      await handleV2Notification({ notification: webhook, client, req });
      const apnsCallsBisect = apnsSendMock.mock.calls as unknown[][];
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
      const dispatched = (apnsCallsBisect[0]![0] as SendCall).notification;
      if (dispatched.notificationData.encryptedMessage === undefined) {
        overLen = mid;
      } else {
        underLen = mid;
      }
    }

    // Sanity: boundary found within ±2 chars
    expect(overLen).toBeGreaterThan(underLen);
    expect(overLen - underLen).toBeLessThanOrEqual(2);

    // Confirm: underLen side passes through unstripped
    apnsSendMock.mockClear();
    const justUnderWebhook = makeWebhook({ encryptedMessageLen: underLen });
    const reqUnder = makeReq();
    await handleV2Notification({
      notification: justUnderWebhook,
      client: makeClient("apns"),
      req: reqUnder,
    });
    const underCalls = apnsSendMock.mock.calls as unknown[][];
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
    const underDispatched = (underCalls[0]![0] as SendCall).notification;
    expect(underDispatched.notificationData.encryptedMessage).toBeDefined();

    // Confirm: overLen side is stripped
    apnsSendMock.mockClear();
    const justOverWebhook = makeWebhook({ encryptedMessageLen: overLen });
    const reqOver = makeReq();
    await handleV2Notification({
      notification: justOverWebhook,
      client: makeClient("apns"),
      req: reqOver,
    });
    const overCalls = apnsSendMock.mock.calls as unknown[][];
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
    const overDispatched = (overCalls[0]![0] as SendCall).notification;
    expect(overDispatched.notificationData.encryptedMessage).toBeUndefined();
  });

  test("Welcome message short-circuit: size-guard does NOT double-strip", async () => {
    const webhook = makeWebhook({
      contentTopic: "/xmtp/mls/1/w-welcome-topic/proto",
      messageType: "v3-welcome",
      encryptedMessageLen: 5000,
    });
    const client = makeClient("apns");
    const req = makeReq();

    await handleV2Notification({ notification: webhook, client, req });

    expect(apnsSendMock).toHaveBeenCalledTimes(1);
    const apnsCallsWelcome = apnsSendMock.mock.calls as unknown[][];
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
    const dispatched = (apnsCallsWelcome[0]![0] as SendCall).notification;
    expect(dispatched.notificationData.encryptedMessage).toBeUndefined();

    // Welcome path logs its own info line; size-guard warn should NOT also fire
    const stripLog = req.capturedLogs.find((l) =>
      l.msg.includes("Payload exceeds strip threshold"),
    );
    expect(stripLog).toBeUndefined();
  });
});

describe("handleV2Notification – reactive PayloadTooLarge retry", () => {
  test("APNS PayloadTooLarge triggers strip + single retry, success", async () => {
    apnsSendMock
      .mockImplementationOnce(() =>
        Promise.resolve({ success: false, error: "PayloadTooLarge" }),
      )
      .mockImplementationOnce(() => Promise.resolve({ success: true }));

    // Small payload — would NOT trip proactive guard
    const webhook = makeWebhook({ encryptedMessageLen: 100 });
    const client = makeClient("apns");
    const req = makeReq();

    await handleV2Notification({ notification: webhook, client, req });

    expect(apnsSendMock).toHaveBeenCalledTimes(2);

    const reactiveCalls = apnsSendMock.mock.calls as unknown[][];

    // First call: encryptedMessage present
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
    const first = (reactiveCalls[0]![0] as SendCall).notification;
    expect(first.notificationData.encryptedMessage).toBeDefined();

    // Second call: encryptedMessage stripped
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
    const second = (reactiveCalls[1]![0] as SendCall).notification;
    expect(second.notificationData.encryptedMessage).toBeUndefined();

    // pushFailures NOT bumped (retry succeeded; also PayloadTooLarge wouldn't bump anyway)
    expect(deviceTxMock).not.toHaveBeenCalled();

    const retryLog = req.capturedLogs.find((l) =>
      l.msg.includes(
        "PayloadTooLarge after proactive guard – retrying stripped",
      ),
    );
    expect(retryLog).toBeDefined();
    expect(retryLog?.level).toBe("warn");
  });

  test("Already-stripped + PayloadTooLarge: no retry (no infinite loop)", async () => {
    apnsSendMock.mockImplementationOnce(() =>
      Promise.resolve({ success: false, error: "PayloadTooLarge" }),
    );

    // Oversize payload → proactive strips first
    const webhook = makeWebhook({ encryptedMessageLen: 4000 });
    const client = makeClient("apns");
    const req = makeReq();

    await handleV2Notification({ notification: webhook, client, req });

    expect(apnsSendMock).toHaveBeenCalledTimes(1);
    expect(deviceTxMock).not.toHaveBeenCalled();

    const errorLog = req.capturedLogs.find((l) =>
      l.msg.includes("PayloadTooLarge on already-stripped payload"),
    );
    expect(errorLog).toBeDefined();
    expect(errorLog?.level).toBe("error");
  });

  test("Welcome + provider PayloadTooLarge: no retry (welcome already stripped)", async () => {
    apnsSendMock.mockImplementationOnce(() =>
      Promise.resolve({ success: false, error: "PayloadTooLarge" }),
    );

    const webhook = makeWebhook({
      contentTopic: "/xmtp/mls/1/w-welcome-topic/proto",
      messageType: "v3-welcome",
      encryptedMessageLen: 100,
    });
    const client = makeClient("apns");
    const req = makeReq();

    await handleV2Notification({ notification: webhook, client, req });

    // Welcome path already stripped, so PayloadTooLarge → no retry
    expect(apnsSendMock).toHaveBeenCalledTimes(1);
    expect(deviceTxMock).not.toHaveBeenCalled();

    const errorLog = req.capturedLogs.find((l) =>
      l.msg.includes("PayloadTooLarge on already-stripped payload"),
    );
    expect(errorLog).toBeDefined();
  });

  test("PayloadTooLarge twice: no pushFailures bump", async () => {
    apnsSendMock
      .mockImplementationOnce(() =>
        Promise.resolve({ success: false, error: "PayloadTooLarge" }),
      )
      .mockImplementationOnce(() =>
        Promise.resolve({ success: false, error: "PayloadTooLarge" }),
      );

    const webhook = makeWebhook({ encryptedMessageLen: 100 });
    const client = makeClient("apns");
    const req = makeReq();

    await handleV2Notification({ notification: webhook, client, req });

    expect(apnsSendMock).toHaveBeenCalledTimes(2);
    expect(deviceTxMock).not.toHaveBeenCalled();

    const retryFailLog = req.capturedLogs.find((l) =>
      l.msg.includes("PayloadTooLarge retry failed"),
    );
    expect(retryFailLog).toBeDefined();
    expect(retryFailLog?.level).toBe("error");
  });
});
