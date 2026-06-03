import type { ClientIdentifier, DeviceRegistration } from "@prisma/client";
import type { Request } from "express";
import { describe, expect, test, vi } from "vitest";
import { isAccountIdMismatch } from "@/api/v2/notifications/handlers/webhook";
import type { WebhookNotificationBody } from "@/notifications/client";

// Pure-function unit tests for the webhook account-id guard. The full webhook
// handler is exercised by integration tests elsewhere; this file pins the
// drop/pass contract on every NULL / mismatch / match permutation so a future
// refactor cannot regress the same-device cross-account push scenario.

const ACCOUNT_A = "00000000-0000-0000-0000-0000000000aa";
const ACCOUNT_B = "00000000-0000-0000-0000-0000000000bb";

function makeClient(args: {
  clientAccountId: string | null;
  deviceAccountId: string | null;
}): ClientIdentifier & { device: DeviceRegistration } {
  const device: DeviceRegistration = {
    deviceId: "dev-1",
    accountId: args.deviceAccountId,
    pushToken: "tok",
    pushTokenType: "apns",
    apnsEnv: "sandbox",
    disabled: false,
    pushFailures: 0,
    lastFailureAt: null,
    lastSentAt: null,
    addedAt: new Date(),
    updatedAt: new Date(),
  };
  return {
    id: "client-1",
    deviceId: "dev-1",
    accountId: args.clientAccountId,
    addedAt: new Date(),
    updatedAt: new Date(),
    device,
  };
}

function makeNotification(): WebhookNotificationBody {
  return {
    installation: { id: "client-1" },
    message: {
      content_topic: "/xmtp/mls/1/g-test/proto",
      message: "encrypted-bytes",
      timestamp_ns: "1717200000000000000",
    },
    message_context: {
      message_type: "v3-application",
      should_push: true,
      is_sender: false,
      has_hmac_key: false,
    },
  } as unknown as WebhookNotificationBody;
}

function makeReq(): {
  req: Request;
  warn: ReturnType<typeof vi.fn>;
} {
  const warn = vi.fn();
  const req = {
    log: {
      warn,
      info: vi.fn(),
      error: vi.fn(),
    },
  } as unknown as Request;
  return { req, warn };
}

describe("isAccountIdMismatch", () => {
  test("both account IDs null -> drop", () => {
    const { req, warn } = makeReq();
    const result = isAccountIdMismatch({
      client: makeClient({ clientAccountId: null, deviceAccountId: null }),
      notification: makeNotification(),
      req,
    });
    expect(result).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    const [logFields] = warn.mock.calls[0] as [Record<string, unknown>];
    expect(logFields.event).toBe("client_account_mismatch");
    expect(logFields.clientAccountId).toBeNull();
    expect(logFields.deviceAccountId).toBeNull();
  });

  test("client null, device set -> drop", () => {
    const { req, warn } = makeReq();
    const result = isAccountIdMismatch({
      client: makeClient({ clientAccountId: null, deviceAccountId: ACCOUNT_A }),
      notification: makeNotification(),
      req,
    });
    expect(result).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test("device null, client set -> drop", () => {
    const { req, warn } = makeReq();
    const result = isAccountIdMismatch({
      client: makeClient({ clientAccountId: ACCOUNT_A, deviceAccountId: null }),
      notification: makeNotification(),
      req,
    });
    expect(result).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test("mismatched non-null -> drop", () => {
    const { req, warn } = makeReq();
    const result = isAccountIdMismatch({
      client: makeClient({
        clientAccountId: ACCOUNT_A,
        deviceAccountId: ACCOUNT_B,
      }),
      notification: makeNotification(),
      req,
    });
    expect(result).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    const [logFields] = warn.mock.calls[0] as [Record<string, unknown>];
    expect(logFields.clientAccountId).toBe(ACCOUNT_A);
    expect(logFields.deviceAccountId).toBe(ACCOUNT_B);
  });

  test("matching non-null -> pass through", () => {
    const { req, warn } = makeReq();
    const result = isAccountIdMismatch({
      client: makeClient({
        clientAccountId: ACCOUNT_A,
        deviceAccountId: ACCOUNT_A,
      }),
      notification: makeNotification(),
      req,
    });
    expect(result).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });
});
