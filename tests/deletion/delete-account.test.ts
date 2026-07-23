import { randomUUID } from "node:crypto";
import { BillingProvider } from "@prisma/client";
import express, { json } from "express";
import request from "supertest";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import { isIdentityBarred } from "@/accounts/deletion/barrier";
import { hashAccountRef } from "@/accounts/deletion/identity-hash";
import { accountDeleteHandler } from "@/api/v2/accounts/handlers/account-delete";
import { writeAdminAudit } from "@/api/v2/credits-admin/audit-repository";
import { authMiddleware, requireAccount } from "@/middleware/auth";
import { pinoMiddleware } from "@/middleware/pino";
import { grant } from "@/payments";
import {
  SUBSCRIPTION_TIER_PLUS,
  SubscriptionPeriod,
  SubscriptionStatus,
  upsertFromVerify,
  type AppleVerifyInput,
} from "@/subscriptions/repository";
import { createJwtToken, validateJWTKeys } from "@/utils/jwt";
import { prisma } from "@/utils/prisma";

vi.mock("firebase-admin/app");
vi.mock("firebase-admin/app-check");
vi.mock("firebase-admin/messaging");

const DAY_MS = 24 * 60 * 60 * 1000;
const PERIOD_START = new Date("2026-06-01T00:00:00.000Z");
const PERIOD_END = new Date(Date.now() + 30 * DAY_MS);
const SENTINEL = "00000000-0000-0000-0000-000000000000";

let previousDeletionFlag: string | undefined;

// Bare app: authMiddleware + handler, without the rate limiters (their
// in-memory per-IP budget would starve the functional tests; wiring and 429
// behavior are covered in delete-endpoint-ratelimit.test.ts).
const makeApp = () => {
  const app = express();
  app.use(pinoMiddleware);
  app.use(json());
  app.delete("/api/v2/accounts/me", authMiddleware, accountDeleteHandler);
  app.get(
    "/api/v2/accounts/me/credits",
    authMiddleware,
    requireAccount,
    (_req, res) => {
      res.json({ ok: true });
    },
  );
  return app;
};

const appleInput = (accountId: string, otx: string): AppleVerifyInput => ({
  provider: BillingProvider.apple,
  accountId,
  appAccountToken: "11111111-2222-3333-4444-555555555555",
  productId: "app.convos.subs.monthly",
  tier: SUBSCRIPTION_TIER_PLUS,
  period: SubscriptionPeriod.monthly,
  status: SubscriptionStatus.active,
  originalTransactionId: otx,
  transactionId: `tx-${otx}`,
  startedAt: PERIOD_START,
  currentPeriodStart: PERIOD_START,
  currentPeriodEnd: PERIOD_END,
  willRenew: true,
  isInTrial: false,
  environment: "sandbox",
  signedPayload: "jws-test-payload",
});

const tokenFor = (accountId: string, deviceId = "dev-delete") =>
  createJwtToken({ deviceId, accountId });

type PopulatedAccount = {
  accountId: string;
  address: string;
  cascadedForeignClientId: string;
  otherAccountId: string;
  forkTemplateId: string;
};

/** Build an account with every child-table class occupied. */
const populateAccount = async (): Promise<PopulatedAccount> => {
  const address = `0x${randomUUID().replaceAll("-", "").padEnd(40, "a").slice(0, 40)}`;
  const account = await prisma.account.create({
    data: {
      authMethods: {
        create: { type: "SIWE", externalKey: address },
      },
    },
  });

  await grant({
    accountId: account.id,
    credits: 100,
    kind: "manual",
    idempotencyKey: `test_grant_${account.id}`,
    note: "test fixture",
  });

  await upsertFromVerify(appleInput(account.id, `otx-${account.id}`));

  const template = await prisma.agentTemplate.create({
    data: {
      slug: `tpl-${account.id.slice(0, 8)}`,
      ownerAccountId: account.id,
      agentName: "Agent",
      prompt: "prompt",
      avatarUrl: `https://assets.test/a/${account.id}/${randomUUID()}`,
      status: "published",
    },
  });
  await prisma.agentTemplateGeneration.create({
    data: {
      ownerAccountId: account.id,
      source: "test",
      idempotencyKey: `gen-${account.id}`,
      inputs: {
        prompt: "make an agent",
        attachments: [{ objectKey: "build/abc123", filename: "a.png" }],
      },
      templateId: template.id,
    },
  });

  // Another account forks the template (must survive with the link nulled).
  const other = await prisma.account.create({ data: {} });
  const fork = await prisma.agentTemplate.create({
    data: {
      slug: `fork-${other.id.slice(0, 8)}`,
      ownerAccountId: other.id,
      forkedFromId: template.id,
      agentName: "Fork",
      prompt: "prompt",
    },
  });

  const cascadedForeignClientId = randomUUID();
  await prisma.deviceRegistration.create({
    data: {
      deviceId: `dev-${account.id.slice(0, 8)}`,
      accountId: account.id,
      clientIdentifiers: {
        create: [
          { id: randomUUID(), accountId: account.id },
          { id: cascadedForeignClientId, accountId: other.id },
        ],
      },
    },
  });
  // Stale client identifier: the device has since re-registered under the
  // other account, but the row still carries the deleted account's id. Only
  // the direct accountId sweep reaches it.
  await prisma.deviceRegistration.create({
    data: {
      deviceId: `dev-stale-${account.id.slice(0, 8)}`,
      accountId: other.id,
      clientIdentifiers: {
        create: { id: randomUUID(), accountId: account.id },
      },
    },
  });

  await prisma.connectionGrant.create({
    data: {
      ownerAccountId: account.id,
      ownerInboxId: "inbox-owner",
      granteeInboxId: "inbox-grantee",
      conversationId: "conv-1",
      toolkit: "googlecalendar",
    },
  });

  await writeAdminAudit({
    accountId: account.id,
    actorEmail: "admin@convos.test",
    action: "grant",
    deltaCredits: 100n,
    reason: "pre-deletion audit",
    idempotencyKey: `pre_del_${account.id}`,
  });

  return {
    accountId: account.id,
    address,
    cascadedForeignClientId,
    otherAccountId: other.id,
    forkTemplateId: fork.id,
  };
};

const wipe = async () => {
  await prisma.deletionTask.deleteMany();
  await prisma.deletionRecord.deleteMany();
  await prisma.deletedIdentity.deleteMany();
  await prisma.subscriptionTransfer.deleteMany();
  await prisma.lineagePeriodCustody.deleteMany();
  await prisma.lineagePeriodGrant.deleteMany();
  await prisma.lineageTokenAlias.deleteMany();
  await prisma.subscriptionLineage.deleteMany();
  await prisma.adminAudit.deleteMany();
  await prisma.clientIdentifier.deleteMany();
  await prisma.deviceRegistration.deleteMany();
  await prisma.connectionGrant.deleteMany();
  await prisma.agentTemplateGeneration.deleteMany();
  await prisma.agentTemplate.deleteMany();
  await prisma.billingReceipt.deleteMany();
  await prisma.subscription.deleteMany();
  await prisma.creditLedger.deleteMany();
  await prisma.userCredits.deleteMany();
  await prisma.authMethod.deleteMany();
  await prisma.account.deleteMany({
    where: { id: { not: "48a05ef4-4a71-57a0-957f-a3d410992b31" } },
  });
};

beforeAll(async () => {
  await validateJWTKeys();
  // Deletion ships default-OFF (ACCOUNT_DELETION_ENABLED env gate); tests
  // opt in explicitly and restore the ambient value afterwards.
  previousDeletionFlag = process.env.ACCOUNT_DELETION_ENABLED;
  process.env.ACCOUNT_DELETION_ENABLED = "true";
});

afterAll(() => {
  if (previousDeletionFlag === undefined) {
    delete process.env.ACCOUNT_DELETION_ENABLED;
  } else {
    process.env.ACCOUNT_DELETION_ENABLED = previousDeletionFlag;
  }
});

afterEach(wipe);

describe("DELETE /v2/accounts/me", () => {
  test("full teardown of a fully-populated account", async () => {
    const {
      accountId,
      address,
      cascadedForeignClientId,
      otherAccountId,
      forkTemplateId,
    } = await populateAccount();
    const operationId = randomUUID();
    const token = await tokenFor(accountId);

    const res = await request(makeApp())
      .delete("/api/v2/accounts/me")
      .set("X-Convos-AuthToken", token)
      .send({ operationId });

    expect(res.status).toBe(200);
    const body = res.body as {
      status: string;
      operationId: string;
      deletedAt: string;
      purgeWindowHours: number;
    };
    expect(body.status).toBe("deleted");
    expect(body.operationId).toBe(operationId);
    expect(body.purgeWindowHours).toBe(24);
    expect(new Date(body.deletedAt).getTime()).toBeGreaterThan(0);

    // Every account-linked row is gone.
    expect(await prisma.account.count({ where: { id: accountId } })).toBe(0);
    expect(await prisma.authMethod.count({ where: { accountId } })).toBe(0);
    expect(await prisma.subscription.count({ where: { accountId } })).toBe(0);
    expect(await prisma.billingReceipt.count()).toBe(0);
    expect(await prisma.creditLedger.count({ where: { accountId } })).toBe(0);
    expect(await prisma.userCredits.count({ where: { accountId } })).toBe(0);
    expect(
      await prisma.agentTemplate.count({
        where: { ownerAccountId: accountId },
      }),
    ).toBe(0);
    expect(
      await prisma.agentTemplateGeneration.count({
        where: { ownerAccountId: accountId },
      }),
    ).toBe(0);
    expect(
      await prisma.deviceRegistration.count({ where: { accountId } }),
    ).toBe(0);
    expect(await prisma.clientIdentifier.count({ where: { accountId } })).toBe(
      0,
    );
    expect(
      await prisma.connectionGrant.count({
        where: { ownerAccountId: accountId },
      }),
    ).toBe(0);

    // The other account's fork survives, unlinked.
    const fork = await prisma.agentTemplate.findUnique({
      where: { id: forkTemplateId },
    });
    expect(fork).not.toBeNull();
    expect(fork?.forkedFromId).toBeNull();
    expect(await prisma.account.count({ where: { id: otherAccountId } })).toBe(
      1,
    );

    // Barrier + tombstoned lineage (with escrowed custody) + record + outbox.
    expect(await isIdentityBarred("SIWE", address)).toBe(true);
    const lineage = await prisma.subscriptionLineage.findUnique({
      where: {
        provider_lineageKey: {
          provider: BillingProvider.apple,
          lineageKey: `otx-${accountId}`,
        },
      },
    });
    expect(lineage?.state).toBe("tombstoned");
    expect(lineage?.deletedAccountRef).toBe(hashAccountRef(accountId));
    const escrow = await prisma.lineagePeriodCustody.findFirst({
      where: { lineageId: lineage?.id ?? "", state: "escrow" },
    });
    expect(escrow).not.toBeNull();
    expect(escrow?.ownerAccountId).toBeNull();
    // The full untouched allotment (2500 test credits) went to escrow.
    expect(escrow?.remainderCap).toBe(2500n);

    const record = await prisma.deletionRecord.findUnique({
      where: { operationId },
    });
    expect(record?.status).toBe("purging");
    expect(record?.accountRef).toBe(hashAccountRef(accountId));

    const tasks = await prisma.deletionTask.findMany({
      where: { operationId },
    });
    const kinds = tasks.map((t) => t.kind).sort();
    // Three client identifiers (owned, stale-owner, and foreign-owned on the
    // deleted device), one avatar, one attachment, one composio user, and one
    // posthog person.
    expect(kinds).toEqual(
      [
        "composio_user",
        "notification_installation",
        "notification_installation",
        "notification_installation",
        "posthog_person",
        "s3_object",
        "s3_object",
      ].sort(),
    );
    expect(
      tasks.some((task) => {
        const payload = task.payload;
        return (
          task.kind === "notification_installation" &&
          typeof payload === "object" &&
          payload !== null &&
          !Array.isArray(payload) &&
          payload.installationId === cascadedForeignClientId
        );
      }),
    ).toBe(true);
    const publicAvatarTask = tasks.find((task) => {
      const payload = task.payload;
      return (
        typeof payload === "object" &&
        payload !== null &&
        !Array.isArray(payload) &&
        payload.target === "public"
      );
    });
    expect(publicAvatarTask?.payload).toMatchObject({
      target: "public",
      accountId,
    });

    // Ops audit: pre-existing entries retained as-is, deletion entry uses
    // the sentinel account id + keyed ref.
    expect(
      await prisma.adminAudit.count({ where: { accountId } }),
    ).toBeGreaterThan(0);
    const deletionAudit = await prisma.adminAudit.findFirst({
      where: { accountId: SENTINEL, action: "account_deletion" },
    });
    expect(deletionAudit?.reason).toContain(hashAccountRef(accountId));
  });

  test("503 fail-closed when the env gate is off, unset, or garbage", async () => {
    const { accountId } = await populateAccount();
    const token = await tokenFor(accountId);
    const app = makeApp();

    // Strict `=== "true"` semantics: anything else — including unset,
    // "false", "1", and the wrong case — reads as OFF.
    for (const value of [undefined, "false", "1", "TRUE"]) {
      if (value === undefined) {
        delete process.env.ACCOUNT_DELETION_ENABLED;
      } else {
        process.env.ACCOUNT_DELETION_ENABLED = value;
      }
      const res = await request(app)
        .delete("/api/v2/accounts/me")
        .set("X-Convos-AuthToken", token)
        .send({ operationId: randomUUID() });
      expect(res.status, `flag=${String(value)}`).toBe(503);
      expect(res.body).toEqual({
        error: "Account deletion is temporarily unavailable",
      });
    }
    // Nothing was deleted while the gate was off.
    expect(await prisma.account.count({ where: { id: accountId } })).toBe(1);

    // Flip back on: the same request now goes through (on→off→on).
    process.env.ACCOUNT_DELETION_ENABLED = "true";
    const res = await request(app)
      .delete("/api/v2/accounts/me")
      .set("X-Convos-AuthToken", token)
      .send({ operationId: randomUUID() });
    expect(res.status).toBe(200);
  });

  // The two replay tests carry the response body and durable DB state in
  // their assertion messages: a rare flake was once observed here and a
  // bare status assertion would discard the actual failure body.
  const replayDiagnostics = async (
    label: string,
    res: request.Response,
  ): Promise<string> => {
    const records = await prisma.deletionRecord.findMany();
    return `${label}: status=${res.status} body=${JSON.stringify(
      res.body,
    )} deletionRecords=${JSON.stringify(records)}`;
  };

  test("replay with the same operationId returns the identical stored record", async () => {
    const { accountId } = await populateAccount();
    const operationId = randomUUID();
    const token = await tokenFor(accountId);

    const first = await request(makeApp())
      .delete("/api/v2/accounts/me")
      .set("X-Convos-AuthToken", token)
      .send({ operationId });
    expect(first.status, await replayDiagnostics("first", first)).toBe(200);

    // The unexpired pre-deletion token still authenticates this one route.
    const second = await request(makeApp())
      .delete("/api/v2/accounts/me")
      .set("X-Convos-AuthToken", token)
      .send({ operationId });
    expect(second.status, await replayDiagnostics("replay", second)).toBe(200);
    expect(second.body).toEqual(first.body);
  });

  test("replay with a different operationId echoes the stored one", async () => {
    const { accountId } = await populateAccount();
    const storedOperationId = randomUUID();
    const token = await tokenFor(accountId);

    const first = await request(makeApp())
      .delete("/api/v2/accounts/me")
      .set("X-Convos-AuthToken", token)
      .send({ operationId: storedOperationId });
    expect(first.status, await replayDiagnostics("first", first)).toBe(200);

    const retry = await request(makeApp())
      .delete("/api/v2/accounts/me")
      .set("X-Convos-AuthToken", token)
      .send({ operationId: randomUUID() });

    expect(retry.status, await replayDiagnostics("retry", retry)).toBe(200);
    expect((retry.body as { operationId: string }).operationId).toBe(
      storedOperationId,
    );
  });

  test("other routes fail closed with the pre-deletion token", async () => {
    const { accountId } = await populateAccount();
    const token = await tokenFor(accountId);
    const app = makeApp();

    await request(app)
      .delete("/api/v2/accounts/me")
      .set("X-Convos-AuthToken", token)
      .send({ operationId: randomUUID() });

    const res = await request(app)
      .get("/api/v2/accounts/me/credits")
      .set("X-Convos-AuthToken", token);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Unauthorized" });
  });

  test("400 on missing/malformed operationId", async () => {
    const { accountId } = await populateAccount();
    const token = await tokenFor(accountId);

    const res = await request(makeApp())
      .delete("/api/v2/accounts/me")
      .set("X-Convos-AuthToken", token)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Invalid request body" });
    // Nothing was deleted.
    expect(await prisma.account.count({ where: { id: accountId } })).toBe(1);
  });

  test("403 for a device-only token (no account claim)", async () => {
    const token = await createJwtToken({ deviceId: "dev-only" });
    const res = await request(makeApp())
      .delete("/api/v2/accounts/me")
      .set("X-Convos-AuthToken", token)
      .send({ operationId: randomUUID() });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Account required" });
  });

  test("401 when the account never existed and no record is stored", async () => {
    const token = await createJwtToken({
      deviceId: "dev-ghost",
      accountId: randomUUID(),
    });
    const res = await request(makeApp())
      .delete("/api/v2/accounts/me")
      .set("X-Convos-AuthToken", token)
      .send({ operationId: randomUUID() });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Unauthorized" });
  });

  test("concurrent deletes converge on one stored record", async () => {
    const { accountId } = await populateAccount();
    const token = await tokenFor(accountId);
    const app = makeApp();

    const [a, b] = await Promise.all([
      request(app)
        .delete("/api/v2/accounts/me")
        .set("X-Convos-AuthToken", token)
        .send({ operationId: randomUUID() }),
      request(app)
        .delete("/api/v2/accounts/me")
        .set("X-Convos-AuthToken", token)
        .send({ operationId: randomUUID() }),
    ]);

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    // Exactly one deletion record exists; both responses echo it.
    const records = await prisma.deletionRecord.findMany({
      where: { accountRef: hashAccountRef(accountId) },
    });
    expect(records).toHaveLength(1);
    expect((a.body as { operationId: string }).operationId).toBe(
      records[0].operationId,
    );
    expect((b.body as { operationId: string }).operationId).toBe(
      records[0].operationId,
    );
  });
});
