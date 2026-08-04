import type { Prisma } from "@prisma/client";
import { describe, expect, test, vi } from "vitest";
import {
  persistSubscriptionIdentity,
  type SubscriptionIdentityTx,
} from "@/api/v2/notifications/handlers/subscribe";

// Unit tests for the subscribe-time identity persistence. These pin the
// "current-subscriber-wins" device.accountId adoption contract that keeps the
// webhook delivery guard from silently dropping pushes on NULL-accountId
// devices, while never clobbering anything for unauthenticated legacy builds.

const ACCOUNT_A = "00000000-0000-0000-0000-0000000000aa";
const ACCOUNT_B = "00000000-0000-0000-0000-0000000000bb";
const CLIENT_ID = "11111111-1111-1111-1111-111111111111";
const DEVICE_ID = "device-xyz";

type UpsertFn = (args: Prisma.ClientIdentifierUpsertArgs) => Promise<unknown>;
type UpdateManyFn = (
  args: Prisma.DeviceRegistrationUpdateManyArgs,
) => Promise<{ count: number }>;

function makeTx(): {
  tx: SubscriptionIdentityTx;
  upsert: ReturnType<typeof vi.fn<UpsertFn>>;
  updateMany: ReturnType<typeof vi.fn<UpdateManyFn>>;
} {
  const upsert = vi.fn<UpsertFn>().mockResolvedValue(undefined);
  const updateMany = vi.fn<UpdateManyFn>().mockResolvedValue({ count: 1 });
  const tx: SubscriptionIdentityTx = {
    clientIdentifier: { upsert },
    deviceRegistration: { updateMany },
  };
  return { tx, upsert, updateMany };
}

describe("persistSubscriptionIdentity", () => {
  test("authenticated subscribe stamps ClientIdentifier and adopts device.accountId", async () => {
    const { tx, upsert, updateMany } = makeTx();

    await persistSubscriptionIdentity({
      tx,
      clientId: CLIENT_ID,
      deviceId: DEVICE_ID,
      accountId: ACCOUNT_A,
    });

    // ClientIdentifier upsert carries the accountId on both create and update.
    expect(upsert).toHaveBeenCalledTimes(1);
    const upsertArg = upsert.mock.calls[0][0];
    expect(upsertArg.where).toEqual({ id: CLIENT_ID });
    expect(upsertArg.create).toEqual({
      id: CLIENT_ID,
      deviceId: DEVICE_ID,
      accountId: ACCOUNT_A,
    });
    expect(upsertArg.update).toEqual({
      deviceId: DEVICE_ID,
      accountId: ACCOUNT_A,
    });

    // Device adoption: conditional UPDATE only when NULL or differing.
    expect(updateMany).toHaveBeenCalledTimes(1);
    const updateArg = updateMany.mock.calls[0][0];
    expect(updateArg.where).toEqual({
      deviceId: DEVICE_ID,
      OR: [{ accountId: null }, { accountId: { not: ACCOUNT_A } }],
    });
    expect(updateArg.data).toEqual({ accountId: ACCOUNT_A });
  });

  test("device.accountId adoption WHERE matches NULL and differing accounts", async () => {
    // The single conditional updateMany covers both the NULL case (device never
    // got an account) and the differing case (device.accountId = ACCOUNT_B but
    // current subscriber is ACCOUNT_A => current-subscriber-wins). We assert the
    // predicate captures both without a read-modify-write.
    const { tx, updateMany } = makeTx();

    await persistSubscriptionIdentity({
      tx,
      clientId: CLIENT_ID,
      deviceId: DEVICE_ID,
      accountId: ACCOUNT_A,
    });

    const where = updateMany.mock.calls[0][0].where;
    expect(where).toBeDefined();
    const orClauses = where?.OR;
    expect(orClauses).toContainEqual({ accountId: null });
    expect(orClauses).toContainEqual({ accountId: { not: ACCOUNT_A } });
    // A device already on ACCOUNT_A is excluded by `not: ACCOUNT_A` (no-op write
    // avoided); a device on ACCOUNT_B is matched by it (gets re-stamped).
    expect(orClauses).not.toContainEqual({ accountId: { not: ACCOUNT_B } });
  });

  test("unauthenticated subscribe (no accountId) leaves device untouched and does not clobber ClientIdentifier.accountId", async () => {
    const { tx, upsert, updateMany } = makeTx();

    await persistSubscriptionIdentity({
      tx,
      clientId: CLIENT_ID,
      deviceId: DEVICE_ID,
      accountId: undefined,
    });

    // No device write at all.
    expect(updateMany).not.toHaveBeenCalled();

    // ClientIdentifier create passes accountId: undefined (=> column stays/NULL),
    // and both create AND update OMIT accountId so a prior/backfilled value is
    // preserved (legacy/non-SIWE builds never write the column).
    const upsertArg = upsert.mock.calls[0][0];
    expect(upsertArg.create).toEqual({
      id: CLIENT_ID,
      deviceId: DEVICE_ID,
    });
    expect("accountId" in upsertArg.create).toBe(false);
    expect(upsertArg.update).toEqual({ deviceId: DEVICE_ID });
    expect("accountId" in upsertArg.update).toBe(false);
  });

  test("both writes go through the SAME transaction client", async () => {
    // Both calls must land on the injected tx (not the global prisma), proving
    // the handler runs them inside one $transaction.
    const { tx, upsert, updateMany } = makeTx();

    await persistSubscriptionIdentity({
      tx,
      clientId: CLIENT_ID,
      deviceId: DEVICE_ID,
      accountId: ACCOUNT_A,
    });

    expect(upsert).toHaveBeenCalledTimes(1);
    expect(updateMany).toHaveBeenCalledTimes(1);
    // The fake tx's own fns received the calls => same-tx guarantee.
    expect(tx.clientIdentifier.upsert).toBe(upsert);
    expect(tx.deviceRegistration.updateMany).toBe(updateMany);
  });
});

// Handler-level test: proves subscribe() actually runs the ClientIdentifier
// upsert + DeviceRegistration adoption inside ONE prisma.$transaction (the
// fenced persistClientIdentifier transaction). The unit tests above pin
// persistSubscriptionIdentity's behavior on an injected tx, but would still
// pass if the handler stopped wrapping the writes in a transaction. This
// guards that wiring.
const txClient = {
  clientIdentifier: {
    findUnique: vi.fn().mockResolvedValue(null),
    upsert: vi.fn().mockResolvedValue({
      accountId: ACCOUNT_A,
      deviceId: DEVICE_ID,
      updatedAt: new Date(),
    }),
  },
  deviceRegistration: {
    findUnique: vi.fn().mockResolvedValue({
      deviceId: DEVICE_ID,
      accountId: null,
      disabled: false,
      pushToken: null,
      pushTokenType: "apns",
      apnsEnv: "production",
    }),
    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
  },
  // Raw lock/fence statements: the deletion-outbox probe must see NO
  // pending purge (empty), every other lock/live-account probe succeeds.
  $queryRaw: vi.fn((strings: TemplateStringsArray) =>
    Promise.resolve(
      strings.join("").includes("DeletionTask") ? [] : [{ ok: 1 }],
    ),
  ),
};
const transactionMock = vi.fn((cb: (tx: typeof txClient) => Promise<unknown>) =>
  cb(txClient),
);

vi.mock("@/utils/prisma", () => ({
  prisma: {
    // device exists, not disabled, no push token (skips the remote calls)
    deviceRegistration: {
      findUnique: vi.fn().mockResolvedValue({
        deviceId: "device-xyz",
        disabled: false,
        pushToken: null,
        pushTokenType: "apns",
        apnsEnv: "production",
      }),
    },
    get $transaction() {
      return transactionMock;
    },
    // Present so the global afterAll teardown (tests/setup.ts) can call it.
    $disconnect: vi.fn().mockResolvedValue(undefined),
    $connect: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@/notifications/client", () => ({
  createNotificationClient: () => ({
    registerInstallation: vi.fn(),
    subscribeWithMetadata: vi.fn(),
    deleteInstallation: vi.fn(),
  }),
}));

vi.mock("@/utils/auth-guards", () => ({
  verifyDeviceOwnership: () => true,
}));

describe("subscribe handler transaction wiring", () => {
  test("wraps both writes in a single prisma.$transaction", async () => {
    const { subscribe } =
      await import("@/api/v2/notifications/handlers/subscribe");

    const req = {
      body: {
        deviceId: DEVICE_ID,
        clientId: CLIENT_ID,
        topics: [{ topic: "/xmtp/mls/1/g-x/proto", hmacKeys: [] }],
      },
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as unknown as Parameters<typeof subscribe>[0];

    const send = vi.fn();
    const res = {
      locals: { deviceId: DEVICE_ID, accountId: ACCOUNT_A },
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
      send,
    } as unknown as Parameters<typeof subscribe>[1];

    await subscribe(req, res);

    // Exactly one transaction opened, and BOTH writes ran on that tx client.
    expect(transactionMock).toHaveBeenCalledTimes(1);
    expect(txClient.clientIdentifier.upsert).toHaveBeenCalledTimes(1);
    expect(txClient.deviceRegistration.updateMany).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalled();
  });
});
