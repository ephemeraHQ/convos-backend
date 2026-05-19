import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import type { Request } from "express";
import type {
  ClientIdentifier,
  DeviceRegistration,
} from "@prisma/client";

// ---- Mocks (must be installed BEFORE importing the SUT) ----

const apnsSendMock = mock(() =>
  Promise.resolve({ success: true } as { success: boolean; error?: string }),
);
const fcmSendMock = mock(() =>
  Promise.resolve({ success: true } as { success: boolean; error?: string }),
);

mock.module("@/api/v2/notifications/apns-push.service", () => ({
  createApnsService: () => ({ sendPushNotification: apnsSendMock }),
}));
mock.module("@/api/v2/notifications/fcm-push.service", () => ({
  createFcmService: () => ({ sendPushNotification: fcmSendMock }),
}));

const deviceUpdateMock = mock(() => Promise.resolve({ pushFailures: 0, lastFailureAt: null }));
const deviceTxMock = mock(() => Promise.resolve({ pushFailures: 1, lastFailureAt: new Date() }));
const clientDeleteMock = mock(() => Promise.resolve());
const txMock = mock(async (fn: (tx: unknown) => Promise<unknown>) =>
  fn({
    deviceRegistration: {
      update: deviceTxMock,
      updateMany: mock(() => Promise.resolve()),
    },
  }),
);

mock.module("@/utils/prisma", () => ({
  prisma: {
    deviceRegistration: { update: deviceUpdateMock },
    clientIdentifier: { delete: clientDeleteMock },
    $transaction: txMock,
  },
}));

mock.module("@/notifications/client", () => ({
  createNotificationClient: () => ({
    deleteInstallation: mock(() => Promise.resolve()),
  }),
  webhookNotificationBodySchema: { safeParse: () => ({ success: true, data: {} }) },
}));

mock.module("@/utils/jwt", () => ({
  createJwtToken: () => Promise.resolve("test-jwt-700-bytes-" + "x".repeat(680)),
}));

const { handleV2Notification } = await import(
  "@/api/v2/notifications/handlers/webhook"
);

// ---- Test helpers ----

type LogLine = { level: string; obj: Record<string, unknown>; msg: string };

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
  return { log, capturedLogs } as unknown as Request & { capturedLogs: LogLine[] };
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
    const dispatched = (apnsCalls[0]![0] as {
      notification: { notificationData: { encryptedMessage?: string } };
    }).notification;
    expect(dispatched.notificationData.encryptedMessage).toBeUndefined();

    const stripLog = req.capturedLogs.find((l) =>
      l.msg.includes("Payload exceeds strip threshold"),
    );
    expect(stripLog).toBeDefined();
    expect(stripLog?.level).toBe("warn");
  });

  test("FCM: oversize encryptedMessage is stripped before dispatch", async () => {
    const webhook = makeWebhook({ encryptedMessageLen: 4000 });
    const client = makeClient("fcm");
    const req = makeReq();

    await handleV2Notification({ notification: webhook, client, req });

    expect(fcmSendMock).toHaveBeenCalledTimes(1);
    const fcmCalls = fcmSendMock.mock.calls as unknown[][];
    const dispatched = (fcmCalls[0]![0] as {
      notification: { notificationData: { encryptedMessage?: string } };
    }).notification;
    expect(dispatched.notificationData.encryptedMessage).toBeUndefined();
  });

  test("Under-threshold payload is NOT stripped", async () => {
    const webhook = makeWebhook({ encryptedMessageLen: 100 });
    const client = makeClient("apns");
    const req = makeReq();

    await handleV2Notification({ notification: webhook, client, req });

    expect(apnsSendMock).toHaveBeenCalledTimes(1);
    const apnsCallsUnder = apnsSendMock.mock.calls as unknown[][];
    const dispatched = (apnsCallsUnder[0]![0] as {
      notification: { notificationData: { encryptedMessage?: string } };
    }).notification;
    expect(dispatched.notificationData.encryptedMessage).toBeDefined();

    const stripLog = req.capturedLogs.find((l) =>
      l.msg.includes("Payload exceeds strip threshold"),
    );
    expect(stripLog).toBeUndefined();
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
    const dispatched = (apnsCallsWelcome[0]![0] as {
      notification: { notificationData: { encryptedMessage?: string } };
    }).notification;
    expect(dispatched.notificationData.encryptedMessage).toBeUndefined();

    // Welcome path logs its own info line; size-guard warn should NOT also fire
    const stripLog = req.capturedLogs.find((l) =>
      l.msg.includes("Payload exceeds strip threshold"),
    );
    expect(stripLog).toBeUndefined();
  });
});
