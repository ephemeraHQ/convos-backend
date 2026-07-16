import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { BillingProvider } from "@prisma/client";
import express, { json } from "express";
import request from "supertest";
import { describe, expect, test, vi } from "vitest";
import { deleteAccount } from "@/accounts/deletion/service";
import { __setClaimAppCheckVerifierForTests } from "@/api/v2/accounts/handlers/subscription-claim";
import { googlePlayWebhookRouter } from "@/api/v2/subscriptions/google-play-webhook.router";
import { pinoMiddleware } from "@/middleware/pino";
import { getBalance } from "@/payments";
import { setAppleApiClientForTests } from "@/subscriptions/apple-server-api";
import { setPlayApiFixtureForTests } from "@/subscriptions/google-play/play-api";
import { PlaySubscriptionState } from "@/subscriptions/google-play/status";
import { setPubsubVerifierForTests } from "@/subscriptions/google-play/verifier";
import { runReclaimReconciliationSweep } from "@/subscriptions/reconciliation";
import {
  SUBSCRIPTION_TIER_PLUS,
  SubscriptionPeriod,
  SubscriptionStatus,
  upsertFromVerify,
  type AppleVerifyInput,
} from "@/subscriptions/repository";
import { prisma } from "@/utils/prisma";
import {
  appleClaimRequest,
  DAY_MS,
  HOUR_MS,
  installAppleStatuses as installAppleStatusesFixture,
  installLocalTestingVerifier,
  installReclaimHooks,
  appleInput as makeAppleInput,
  appleStatuses as makeAppleStatuses,
  newAccount,
  NEXT_PERIOD_END,
  PERIOD_CREDITS,
  PERIOD_END,
  PERIOD_START,
  playInput,
  playPurchase,
  PRODUCT_ID,
  signTransaction as signReclaimTransaction,
} from "./reclaim-fixtures";

vi.mock("firebase-admin/app");
vi.mock("firebase-admin/app-check");
vi.mock("firebase-admin/messaging");
const OTX = "6000000000000001";
const DRIFT_BATCH = 50;
const DRIFT_MAX_PER_SWEEP = 3 * DRIFT_BATCH;
const signTransaction = (overrides: Record<string, unknown> = {}) =>
  signReclaimTransaction(OTX, overrides);
const appleInput = (
  accountId: string,
  overrides: Partial<AppleVerifyInput> = {},
) => makeAppleInput(accountId, OTX, overrides);
const appleStatuses = (args: {
  status: number;
  signedLatest: string;
  originalTransactionId?: string;
}) =>
  makeAppleStatuses({
    otx: args.originalTransactionId ?? OTX,
    status: args.status,
    signedLatest: args.signedLatest,
  });
const installAppleStatuses = (args: {
  status: number;
  signedLatest: string;
  originalTransactionId?: string;
}) => {
  installAppleStatusesFixture({
    otx: args.originalTransactionId ?? OTX,
    status: args.status,
    signedLatest: args.signedLatest,
  });
};

const rtdnApp = () => {
  const app = express();
  app.use(pinoMiddleware);
  app.use(json());
  app.use("/v2/webhooks/google-play", googlePlayWebhookRouter);
  return app;
};

installReclaimHooks();

/** Delete then restore an Apple subscription, producing one committed journal. */
const createRestoredSubscription = async () => {
  installLocalTestingVerifier();
  __setClaimAppCheckVerifierForTests(() => Promise.resolve());
  const owner = await newAccount();
  await upsertFromVerify(appleInput(owner));
  await deleteAccount({ accountId: owner, operationId: randomUUID() });
  const jws = await signTransaction();
  installAppleStatuses({ status: 1, signedLatest: jws });
  const claimer = await newAccount();
  const res = await appleClaimRequest(claimer, jws);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return { owner, claimer, jws };
};

/** Minimal live Apple lineage + subscription for cursor-only drift tests. */
const createDriftFixture = async (
  accountId: string,
  originalTransactionId: string,
) => {
  const lineage = await prisma.subscriptionLineage.create({
    data: {
      provider: BillingProvider.apple,
      lineageKey: originalTransactionId,
    },
  });
  await prisma.subscription.create({
    data: {
      accountId,
      provider: BillingProvider.apple,
      productId: PRODUCT_ID,
      tier: SUBSCRIPTION_TIER_PLUS,
      period: SubscriptionPeriod.monthly,
      status: SubscriptionStatus.active,
      originalTransactionId,
      startedAt: PERIOD_START,
      currentPeriodStart: PERIOD_START,
      currentPeriodEnd: PERIOD_END,
      lineageId: lineage.id,
    },
  });
  return lineage.id;
};

describe("durable drift scheduling and rolling safety", () => {
  test(">50 equal-millisecond schedules are each swept once in one tick", async () => {
    const owner = await newAccount();
    const providerCalls = new Map<string, number>();

    for (let i = 0; i < 51; i += 1) {
      const originalTransactionId = `drift-cursor-${i}`;
      const lineageId = await createDriftFixture(owner, originalTransactionId);
      const journal = await prisma.subscriptionTransfer.create({
        data: {
          lineageId,
          kind: "transfer",
          status: "committed",
          fromAccountId: owner,
          toAccountId: owner,
        },
      });
      expect(journal.committedAt).toBeInstanceOf(Date);
    }
    const dueAt = new Date(Date.now() - HOUR_MS);
    await prisma.subscriptionDriftSchedule.updateMany({
      data: {
        nextDriftCheckAt: dueAt,
        monitorUntil: new Date(dueAt.getTime() + DAY_MS),
      },
    });
    setAppleApiClientForTests({
      getAllSubscriptionStatuses: (originalTransactionId: string) => {
        providerCalls.set(
          originalTransactionId,
          (providerCalls.get(originalTransactionId) ?? 0) + 1,
        );
        return Promise.resolve(
          appleStatuses({
            status: 1,
            signedLatest: "fresh",
            originalTransactionId,
          }),
        );
      },
    } as never);

    const first = await runReclaimReconciliationSweep();
    expect(first.driftChecked).toBe(51);
    expect(first.driftBacklogRemaining).toBe(0);
    expect(providerCalls.size).toBe(51);
    expect([...providerCalls.values()]).toEqual(Array(51).fill(1));
  });

  test("DB commit time overrides a slow replica stamp and schedules the journal", async () => {
    const owner = await newAccount();
    const originalTransactionId = "r6-slow-clock";
    const lineageId = await createDriftFixture(owner, originalTransactionId);
    const [{ now: beforeInsert }] = await prisma.$queryRaw<
      Array<{ now: Date }>
    >`SELECT clock_timestamp() AS now`;
    const journalId = randomUUID();
    const slowReplicaTime = new Date(beforeInsert.getTime() - HOUR_MS);
    await prisma.$executeRaw`
      INSERT INTO "SubscriptionTransfer"
        (id, "lineageId", kind, status, "committedAt", "updatedAt")
      VALUES
        (${journalId}::uuid, ${lineageId}::uuid, 'transfer', 'committed', ${slowReplicaTime}, CURRENT_TIMESTAMP)
    `;
    const journal = await prisma.subscriptionTransfer.findUniqueOrThrow({
      where: { id: journalId },
    });
    expect(journal.committedAt.getTime()).toBeGreaterThanOrEqual(
      beforeInsert.getTime(),
    );
    expect(journal.committedAt.getTime()).toBeGreaterThan(
      slowReplicaTime.getTime(),
    );
    const schedule = await prisma.subscriptionDriftSchedule.findUniqueOrThrow({
      where: { lineageId },
    });
    expect(schedule.monitorUntil.getTime()).toBeGreaterThan(
      journal.committedAt.getTime(),
    );
    installAppleStatuses({
      status: 1,
      signedLatest: "fresh",
      originalTransactionId,
    });
    expect((await runReclaimReconciliationSweep()).driftChecked).toBe(1);
  });

  test("the committed-row backfill normalizes a pre-trigger non-null stamp", async () => {
    const owner = await newAccount();
    const originalTransactionId = "pre-trigger-non-null";
    const lineageId = await createDriftFixture(owner, originalTransactionId);
    const journalId = randomUUID();
    const migrationSql = readFileSync(
      new URL(
        "../../prisma/migrations/20260715170000_harden_reconciliation_drift_cursor/migration.sql",
        import.meta.url,
      ),
      "utf8",
    );
    const committedBackfill = migrationSql.match(
      /UPDATE "SubscriptionTransfer"\s+SET "committedAt" = clock_timestamp\(\)\s+WHERE status = 'committed'[^;]*;/,
    )?.[0];
    if (!committedBackfill) {
      throw new Error("committedAt backfill statement not found");
    }

    await prisma.$transaction(async (tx) => {
      // Recreate the migration boundary: a legacy writer lands after the
      // default but before either trigger is installed. Transactional DDL
      // guarantees a failed assertion rolls both trigger changes back.
      await tx.$executeRawUnsafe(`
        ALTER TABLE "SubscriptionTransfer"
        DISABLE TRIGGER "SubscriptionTransfer_stamp_committed_at"
      `);
      await tx.$executeRawUnsafe(`
        ALTER TABLE "SubscriptionTransfer"
        DISABLE TRIGGER "SubscriptionTransfer_schedule_drift"
      `);
      const [{ now: beforeInsert }] = await tx.$queryRaw<
        Array<{ now: Date }>
      >`SELECT clock_timestamp() AS now`;
      const applicationClock = new Date(beforeInsert.getTime() + HOUR_MS);
      await tx.$executeRaw`
        INSERT INTO "SubscriptionTransfer"
          (id, "lineageId", kind, status, "committedAt", "updatedAt")
        VALUES
          (${journalId}::uuid, ${lineageId}::uuid, 'transfer', 'committed', ${applicationClock}, CURRENT_TIMESTAMP)
      `;
      const beforeBackfill = await tx.subscriptionTransfer.findUniqueOrThrow({
        where: { id: journalId },
      });
      expect(beforeBackfill.committedAt.getTime()).toBe(
        applicationClock.getTime(),
      );

      await tx.$executeRawUnsafe(`
        ALTER TABLE "SubscriptionTransfer"
        ENABLE TRIGGER "SubscriptionTransfer_stamp_committed_at"
      `);
      const [{ now: normalizationStartedAt }] = await tx.$queryRaw<
        Array<{ now: Date }>
      >`SELECT clock_timestamp() AS now`;
      await tx.$executeRawUnsafe(committedBackfill);
      const normalized = await tx.subscriptionTransfer.findUniqueOrThrow({
        where: { id: journalId },
      });
      expect(normalized.committedAt.getTime()).toBeLessThan(
        applicationClock.getTime(),
      );
      expect(normalized.committedAt.getTime()).toBeGreaterThanOrEqual(
        normalizationStartedAt.getTime() - 1,
      );

      await tx.$executeRawUnsafe(`
        ALTER TABLE "SubscriptionTransfer"
        ENABLE TRIGGER "SubscriptionTransfer_schedule_drift"
      `);
    });
  });

  test("an already-committed journal cannot be restamped to the future", async () => {
    const owner = await newAccount();
    const originalTransactionId = "immutable-commit-time";
    const lineageId = await createDriftFixture(owner, originalTransactionId);
    const journal = await prisma.subscriptionTransfer.create({
      data: {
        lineageId,
        kind: "transfer",
        status: "committed",
        fromAccountId: owner,
        toAccountId: owner,
      },
    });
    const [{ now: beforeUpdate }] = await prisma.$queryRaw<
      Array<{ now: Date }>
    >`SELECT clock_timestamp() AS now`;
    const callerFuture = new Date(beforeUpdate.getTime() + HOUR_MS);
    const updated = await prisma.subscriptionTransfer.update({
      where: { id: journal.id },
      data: { committedAt: callerFuture },
    });
    const [{ now: afterUpdate }] = await prisma.$queryRaw<
      Array<{ now: Date }>
    >`SELECT clock_timestamp() AS now`;
    expect(updated.committedAt.getTime()).toBeGreaterThanOrEqual(
      beforeUpdate.getTime() - 1,
    );
    expect(updated.committedAt.getTime()).toBeLessThanOrEqual(
      afterUpdate.getTime(),
    );
    expect(updated.committedAt.getTime()).toBeLessThan(callerFuture.getTime());
    const schedule = await prisma.subscriptionDriftSchedule.findUniqueOrThrow({
      where: { lineageId },
    });
    expect(schedule.monitorUntil.getTime()).toBeLessThan(
      callerFuture.getTime() + DAY_MS,
    );
  });

  test("an old-replica committed insert with NULL is DB-stamped and swept", async () => {
    const owner = await newAccount();
    const originalTransactionId = "r6-old-replica-null";
    const lineageId = await createDriftFixture(owner, originalTransactionId);
    const journalId = randomUUID();
    await prisma.$executeRaw`
      INSERT INTO "SubscriptionTransfer"
        (id, "lineageId", kind, status, "committedAt", "updatedAt")
      VALUES
        (${journalId}::uuid, ${lineageId}::uuid, 'transfer', 'committed', NULL, CURRENT_TIMESTAMP)
    `;
    const journal = await prisma.subscriptionTransfer.findUniqueOrThrow({
      where: { id: journalId },
    });
    expect(journal.committedAt).toBeInstanceOf(Date);
    installAppleStatuses({
      status: 1,
      signedLatest: "fresh",
      originalTransactionId,
    });
    expect((await runReclaimReconciliationSweep()).driftChecked).toBe(1);
  });

  test("a later sweep catches revocation after an earlier entitled answer", async () => {
    const { claimer, jws } = await createRestoredSubscription();
    expect(await getBalance(claimer)).toBe(PERIOD_CREDITS);

    installAppleStatuses({ status: 1, signedLatest: jws });
    const first = await runReclaimReconciliationSweep();
    expect(first.driftChecked).toBe(1);
    expect(first.driftCompensated).toBe(0);

    // The provider revokes after the first entitled answer and its webhook is
    // lost. Simulate a later tick: the lineage is due, beyond the two-minute
    // visibility margin, and still inside its 24-hour monitoring deadline.
    const [{ now }] = await prisma.$queryRaw<Array<{ now: Date }>>`
      SELECT clock_timestamp() AS now
    `;
    const lineage = await prisma.subscriptionLineage.findFirstOrThrow({
      where: { lineageKey: OTX },
    });
    await prisma.subscriptionDriftSchedule.update({
      where: { lineageId: lineage.id },
      data: {
        nextDriftCheckAt: new Date(now.getTime() - HOUR_MS),
        monitorUntil: new Date(now.getTime() + 23 * HOUR_MS),
      },
    });
    installAppleStatuses({ status: 2, signedLatest: "irrelevant" });
    const later = await runReclaimReconciliationSweep();
    expect(later.driftChecked).toBe(1);
    expect(later.driftCompensated).toBe(1);
    expect(await getBalance(claimer)).toBe(0n);
  });

  test("a revoke after the last periodic check is clawed at the deadline", async () => {
    const { claimer } = await createRestoredSubscription();
    const lineage = await prisma.subscriptionLineage.findFirstOrThrow({
      where: { lineageKey: OTX },
    });
    let providerStatus = 1;
    let providerCalls = 0;
    setAppleApiClientForTests({
      getAllSubscriptionStatuses: () => {
        providerCalls += 1;
        return Promise.resolve(
          appleStatuses({
            status: providerStatus,
            signedLatest: "deadline-status",
          }),
        );
      },
    } as never);
    const [{ now: beforePeriodic }] = await prisma.$queryRaw<
      Array<{ now: Date }>
    >`SELECT clock_timestamp() AS now`;
    const monitorUntil = new Date(beforePeriodic.getTime() + 5 * 60 * 1000);
    await prisma.subscriptionDriftSchedule.update({
      where: { lineageId: lineage.id },
      data: {
        nextDriftCheckAt: new Date(beforePeriodic.getTime() - 1),
        monitorUntil,
      },
    });

    const periodic = await runReclaimReconciliationSweep();
    expect(periodic.driftChecked).toBe(1);
    expect(periodic.driftCompensated).toBe(0);
    const lastPeriodic =
      await prisma.subscriptionDriftSchedule.findUniqueOrThrow({
        where: { lineageId: lineage.id },
      });
    expect(lastPeriodic.nextDriftCheckAt.getTime()).toBe(
      monitorUntil.getTime() - 1,
    );

    // The webhook is lost after that last entitled answer. Advance only the
    // durable deadline, then prove the terminal pass re-fetches provider
    // truth and invalidates the restored custody.
    providerStatus = 2;
    const [{ now: afterPeriodic }] = await prisma.$queryRaw<
      Array<{ now: Date }>
    >`SELECT clock_timestamp() AS now`;
    await prisma.subscriptionDriftSchedule.update({
      where: { lineageId: lineage.id },
      data: {
        nextDriftCheckAt: new Date(afterPeriodic.getTime() + HOUR_MS),
        monitorUntil: new Date(afterPeriodic.getTime() - 1),
      },
    });
    const deadline = await runReclaimReconciliationSweep();
    expect(deadline.driftDeadlineChecks).toBe(1);
    expect(deadline.driftChecked).toBe(1);
    expect(deadline.driftCompensated).toBe(1);
    expect(providerCalls).toBe(2);
    expect(await getBalance(claimer)).toBe(0n);
    const custody = await prisma.lineagePeriodCustody.findFirstOrThrow({});
    expect(custody.state).toBe("invalidated");
  });

  test("the deadline resolves only after exactly one final provider check", async () => {
    const owner = await newAccount();
    const originalTransactionId = "deadline-final-check";
    const lineageId = await createDriftFixture(owner, originalTransactionId);
    await prisma.subscriptionTransfer.create({
      data: {
        lineageId,
        kind: "transfer",
        status: "committed",
        fromAccountId: owner,
        toAccountId: owner,
      },
    });
    const [{ now }] = await prisma.$queryRaw<Array<{ now: Date }>>`
      SELECT clock_timestamp() AS now
    `;
    await prisma.subscriptionDriftSchedule.update({
      where: { lineageId },
      data: {
        nextDriftCheckAt: new Date(now.getTime() + HOUR_MS),
        monitorUntil: new Date(now.getTime() - 1),
      },
    });
    let providerCalls = 0;
    setAppleApiClientForTests({
      getAllSubscriptionStatuses: () => {
        providerCalls += 1;
        return Promise.resolve(
          appleStatuses({
            status: 1,
            signedLatest: "still-entitled",
            originalTransactionId,
          }),
        );
      },
    } as never);

    const counts = await runReclaimReconciliationSweep();
    expect(counts.driftDeadlineChecks).toBe(1);
    expect(counts.driftChecked).toBe(1);
    expect(providerCalls).toBe(1);
    const resolved = await prisma.subscriptionDriftSchedule.findUniqueOrThrow({
      where: { lineageId },
    });
    expect(resolved.resolvedAt).not.toBeNull();
    expect(resolved.needsOperatorAt).toBeNull();
  });

  test("an unknown provider answer at the deadline escalates immediately", async () => {
    const owner = await newAccount();
    const originalTransactionId = "deadline-unknown";
    const lineageId = await createDriftFixture(owner, originalTransactionId);
    await prisma.subscriptionTransfer.create({
      data: {
        lineageId,
        kind: "transfer",
        status: "committed",
        fromAccountId: owner,
        toAccountId: owner,
      },
    });
    const [{ now }] = await prisma.$queryRaw<Array<{ now: Date }>>`
      SELECT clock_timestamp() AS now
    `;
    await prisma.subscriptionDriftSchedule.update({
      where: { lineageId },
      data: {
        nextDriftCheckAt: new Date(now.getTime() + HOUR_MS),
        monitorUntil: new Date(now.getTime() - 1),
      },
    });
    let providerCalls = 0;
    setAppleApiClientForTests({
      getAllSubscriptionStatuses: () => {
        providerCalls += 1;
        return Promise.reject(new Error("provider unavailable at deadline"));
      },
    } as never);

    const counts = await runReclaimReconciliationSweep();
    expect(counts.driftDeadlineChecks).toBe(1);
    expect(counts.driftDeferred).toBe(1);
    expect(providerCalls).toBe(1);
    const escalated = await prisma.subscriptionDriftSchedule.findUniqueOrThrow({
      where: { lineageId },
    });
    expect(escalated.attempts).toBe(1);
    expect(escalated.needsOperatorAt).not.toBeNull();
    expect(escalated.resolvedAt).toBeNull();
  });

  test("a permanently deferred lineage cannot block a healthy compensation", async () => {
    const owner = await newAccount();
    const unavailableOtx = "r7-permanent-deferral";
    const unavailableLineageId = await createDriftFixture(
      owner,
      unavailableOtx,
    );
    await prisma.subscriptionTransfer.create({
      data: {
        lineageId: unavailableLineageId,
        kind: "transfer",
        status: "committed",
        fromAccountId: owner,
        toAccountId: owner,
      },
    });
    const { claimer } = await createRestoredSubscription();
    setAppleApiClientForTests({
      getAllSubscriptionStatuses: (originalTransactionId: string) => {
        if (originalTransactionId === unavailableOtx) {
          return Promise.reject(new Error("provider permanently unavailable"));
        }
        return Promise.resolve(
          appleStatuses({
            status: 2,
            signedLatest: "revoked",
            originalTransactionId,
          }),
        );
      },
    } as never);

    // Both are in the same bounded batch. The first lineage defers, but its
    // private backoff cannot stop the later healthy lineage from being clawed.
    const first = await runReclaimReconciliationSweep();
    expect(first.driftChecked).toBe(2);
    expect(first.driftDeferred).toBe(1);
    expect(first.driftCompensated).toBe(1);
    expect(await getBalance(claimer)).toBe(0n);
    const deferred = await prisma.subscriptionDriftSchedule.findUniqueOrThrow({
      where: { lineageId: unavailableLineageId },
    });
    expect(deferred.attempts).toBe(1);
    expect(deferred.nextDriftCheckAt.getTime()).toBeGreaterThan(Date.now());

    // Prove the bounded terminal state without sleeping through ten retries.
    await prisma.subscriptionDriftSchedule.update({
      where: { lineageId: unavailableLineageId },
      data: {
        attempts: 9,
        nextDriftCheckAt: new Date(Date.now() - HOUR_MS),
      },
    });
    await runReclaimReconciliationSweep();
    const escalated = await prisma.subscriptionDriftSchedule.findUniqueOrThrow({
      where: { lineageId: unavailableLineageId },
    });
    expect(escalated.attempts).toBe(10);
    expect(escalated.needsOperatorAt).not.toBeNull();
  });

  test("one tick drains three pages and reports the capacity overflow", async () => {
    const owner = await newAccount();
    const fixtureCount = DRIFT_MAX_PER_SWEEP + 1;
    const fixtures = Array.from({ length: fixtureCount }, (_, i) => ({
      lineageId: randomUUID(),
      originalTransactionId: `drift-backlog-${i}`,
    }));
    await prisma.subscriptionLineage.createMany({
      data: fixtures.map(({ lineageId, originalTransactionId }) => ({
        id: lineageId,
        provider: BillingProvider.apple,
        lineageKey: originalTransactionId,
      })),
    });
    await prisma.subscription.createMany({
      data: fixtures.map(({ lineageId, originalTransactionId }) => ({
        accountId: owner,
        provider: BillingProvider.apple,
        productId: PRODUCT_ID,
        tier: SUBSCRIPTION_TIER_PLUS,
        period: SubscriptionPeriod.monthly,
        status: SubscriptionStatus.active,
        originalTransactionId,
        startedAt: PERIOD_START,
        currentPeriodStart: PERIOD_START,
        currentPeriodEnd: PERIOD_END,
        lineageId,
      })),
    });
    await prisma.subscriptionTransfer.createMany({
      data: fixtures.map(({ lineageId }) => ({
        lineageId,
        kind: "transfer",
        status: "committed",
        fromAccountId: owner,
        toAccountId: owner,
      })),
    });
    const providerCalls = new Map<string, number>();
    setAppleApiClientForTests({
      getAllSubscriptionStatuses: (originalTransactionId: string) => {
        providerCalls.set(
          originalTransactionId,
          (providerCalls.get(originalTransactionId) ?? 0) + 1,
        );
        return Promise.resolve(
          appleStatuses({
            status: 1,
            signedLatest: "fresh",
            originalTransactionId,
          }),
        );
      },
    } as never);

    // One production tick drains three 50-row pages. The bounded overflow is
    // observable and remains unresolved/due inside its monitoring window.
    const first = await runReclaimReconciliationSweep();
    expect(first.driftChecked).toBe(DRIFT_MAX_PER_SWEEP);
    expect(first.driftBacklogRemaining).toBe(1);
    expect(providerCalls.size).toBe(DRIFT_MAX_PER_SWEEP);
    const [{ now: afterFirst }] = await prisma.$queryRaw<Array<{ now: Date }>>`
      SELECT clock_timestamp() AS now
    `;
    expect(
      await prisma.subscriptionDriftSchedule.count({
        where: {
          resolvedAt: null,
          needsOperatorAt: null,
          nextDriftCheckAt: { lte: afterFirst },
          monitorUntil: { gt: afterFirst },
        },
      }),
    ).toBe(1);

    const second = await runReclaimReconciliationSweep();
    expect(second.driftChecked).toBe(1);
    expect(second.driftBacklogRemaining).toBe(0);
    expect(providerCalls.size).toBe(fixtureCount);
    expect([...providerCalls.values()]).toEqual(Array(fixtureCount).fill(1));
  });
});

describe("quarantine retry state prevents starvation", () => {
  test("30 persistent rows cannot starve a newer recoverable row", async () => {
    const owner = await newAccount();
    const recoverableToken = "r5-recoverable";
    await upsertFromVerify(playInput(owner, recoverableToken));
    expect(await getBalance(owner)).toBe(PERIOD_CREDITS);

    // 30 persistently-keyless rows, all due before the recoverable row.
    await prisma.lineageQuarantine.createMany({
      data: Array.from({ length: 30 }, (_, i) => ({
        provider: BillingProvider.googlePlay,
        token: `r5-starving-${i}`,
        reason: "missing_latest_order_id",
        payload: { source: "rtdn" },
        nextAttemptAt: new Date(Date.now() - 10_000),
      })),
    });
    await prisma.lineageQuarantine.create({
      data: {
        provider: BillingProvider.googlePlay,
        token: recoverableToken,
        reason: "missing_latest_order_id",
        payload: { source: "rtdn" },
      },
    });
    setPlayApiFixtureForTests((token) =>
      token === recoverableToken
        ? playPurchase({
            latestOrderId: `GPA.${recoverableToken}..1`,
            expiry: NEXT_PERIOD_END,
          })
        : playPurchase({ latestOrderId: null }),
    );

    // First sweep: the batch fills with 25 persistent rows; each defers
    // with backoff (the old fixed oldest-25 selection would reselect these
    // same rows forever).
    const first = await runReclaimReconciliationSweep();
    expect(first.quarantineDeferred).toBe(25);
    expect(first.quarantineRecovered).toBe(0);

    // Second sweep: the deferred rows are backed off out of the batch, so
    // the newer recoverable row is reached and resolved.
    const second = await runReclaimReconciliationSweep();
    expect(second.quarantineRecovered).toBe(1);
    const resolved = await prisma.lineageQuarantine.findFirstOrThrow({
      where: { token: recoverableToken },
    });
    expect(resolved.resolvedAt).not.toBeNull();
    expect(await getBalance(owner)).toBe(2n * PERIOD_CREDITS);
    // The persistent rows carry their retry state instead of hogging the
    // batch: attempts counted, next attempt backed off into the future.
    const starving = await prisma.lineageQuarantine.findFirstOrThrow({
      where: { token: "r5-starving-0" },
    });
    expect(starving.attempts).toBeGreaterThanOrEqual(1);
    expect(starving.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
    expect(starving.resolvedAt).toBeNull();
  });
});

describe("drift-versus-renewal race", () => {
  test("a renewal landing between the provider fetch and the lock survives (version fence)", async () => {
    const { claimer } = await createRestoredSubscription();
    expect(await getBalance(claimer)).toBe(PERIOD_CREDITS);
    const renewalTxn = "6000000000000042";

    // The provider mock interleaves the exact TOCTOU: while the sweep is
    // fetching entitlement, a renewal webhook advances the subscription and
    // funds the new period; the fetch then answers with the STALE
    // "not entitled" for the old period.
    let renewed = false;
    setAppleApiClientForTests({
      getAllSubscriptionStatuses: async () => {
        if (!renewed) {
          renewed = true;
          await upsertFromVerify(
            appleInput(claimer, {
              transactionId: renewalTxn,
              currentPeriodStart: PERIOD_END,
              currentPeriodEnd: NEXT_PERIOD_END,
            }),
          );
          return appleStatuses({ status: 2, signedLatest: "stale" });
        }
        return appleStatuses({ status: 1, signedLatest: "fresh" });
      },
    } as never);

    const first = await runReclaimReconciliationSweep();
    expect(renewed).toBe(true);
    // The fence tripped: nothing was clawed with the stale answer.
    expect(first.driftDeferred).toBe(1);
    expect(first.driftCompensated).toBe(0);
    expect(await getBalance(claimer)).toBe(2n * PERIOD_CREDITS);
    const renewedCustody = await prisma.lineagePeriodCustody.findFirstOrThrow({
      where: { providerPeriodKey: `apple_txn_${renewalTxn}` },
    });
    expect(renewedCustody.state).toBe("held");

    // The deferred lineage owns its retry time. Make that retry due without
    // sleeping; the next sweep re-fetches fresh state and claws nothing.
    const lineage = await prisma.subscriptionLineage.findFirstOrThrow({
      where: { lineageKey: OTX },
    });
    await prisma.subscriptionDriftSchedule.update({
      where: { lineageId: lineage.id },
      data: { nextDriftCheckAt: new Date(Date.now() - HOUR_MS) },
    });
    const second = await runReclaimReconciliationSweep();
    expect(second.driftChecked).toBe(1);
    expect(second.driftCompensated).toBe(0);
    expect(await getBalance(claimer)).toBe(2n * PERIOD_CREDITS);
    const row = await prisma.subscription.findFirstOrThrow({
      where: { originalTransactionId: OTX },
    });
    expect(row.status).toBe(SubscriptionStatus.active);
  });
});

describe("keyless void reconciliation end-to-end", () => {
  const postKeylessVoid = async (token: string) => {
    setPubsubVerifierForTests(() => undefined);
    const res = await request(rtdnApp())
      .post("/v2/webhooks/google-play/rtdn")
      .send({
        message: {
          messageId: `msg-${randomUUID()}`,
          data: Buffer.from(
            JSON.stringify({
              voidedPurchaseNotification: { purchaseToken: token },
            }),
          ).toString("base64"),
        },
      });
    expect(res.status).toBe(200);
    const parked = await prisma.lineageQuarantine.findFirstOrThrow({
      where: { token, reason: "voided_purchase_keyless" },
    });
    return parked;
  };

  test("void of the current order: terminal state applied, exact period clawed, row resolved", async () => {
    const owner = await newAccount();
    const token = "r5-void-current";
    await upsertFromVerify(playInput(owner, token));
    await postKeylessVoid(token);

    // Fresh provider state: the subscription is voided (expired, order
    // identity present) - the sweep applies terminal state and compensates
    // through the hardened notification path.
    setPlayApiFixtureForTests(() =>
      playPurchase({
        latestOrderId: `GPA.${token}..0`,
        state: PlaySubscriptionState.expired,
        expiry: new Date(Date.now() - 60_000),
      }),
    );
    const counts = await runReclaimReconciliationSweep();
    expect(counts.quarantineRecovered).toBe(1);
    expect(await getBalance(owner)).toBe(0n);
    const custody = await prisma.lineagePeriodCustody.findFirstOrThrow({
      where: { providerPeriodKey: `play_order_GPA.${token}..0` },
    });
    expect(custody.state).toBe("invalidated");
    const row = await prisma.subscription.findFirstOrThrow({
      where: { purchaseToken: token },
    });
    expect(row.status).toBe(SubscriptionStatus.expired);
    const resolved = await prisma.lineageQuarantine.findFirstOrThrow({
      where: { token },
    });
    expect(resolved.resolvedAt).not.toBeNull();
  });

  test("void of an unidentifiable historical order: escalated, never mislabeled recovered", async () => {
    const owner = await newAccount();
    const token = "r5-void-historic";
    await upsertFromVerify(playInput(owner, token));
    await postKeylessVoid(token);

    // Fresh provider state is still entitled: the void hit some historical
    // order that current state cannot identify. The old sweep applied the
    // active state and marked the row recovered - silently dropping the
    // void. It must escalate to an operator instead.
    setPlayApiFixtureForTests(() =>
      playPurchase({ latestOrderId: `GPA.${token}..3` }),
    );
    const counts = await runReclaimReconciliationSweep();
    expect(counts.quarantineRecovered).toBe(0);
    expect(counts.quarantineNeedsOperator).toBe(1);
    const parked = await prisma.lineageQuarantine.findFirstOrThrow({
      where: { token },
    });
    expect(parked.resolvedAt).toBeNull();
    expect(parked.needsOperatorAt).not.toBeNull();
    // Entitlement untouched.
    expect(await getBalance(owner)).toBe(PERIOD_CREDITS);
    const row = await prisma.subscription.findFirstOrThrow({
      where: { purchaseToken: token },
    });
    expect(row.status).toBe(SubscriptionStatus.active);
    // Escalated rows leave the retry batch: a later sweep only surfaces
    // them in the operator count, never re-drives them.
    const second = await runReclaimReconciliationSweep();
    expect(second.quarantineDeferred).toBe(0);
    expect(second.quarantineNeedsOperator).toBe(1);
  });
});

describe("sweep lease exclusivity", () => {
  test("two concurrent runners: exactly one executes", async () => {
    const { claimer } = await createRestoredSubscription();
    expect(await getBalance(claimer)).toBe(PERIOD_CREDITS);

    // Gate the provider call so runner A verifiably holds the lease while
    // runner B attempts it.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let providerCalls = 0;
    setAppleApiClientForTests({
      getAllSubscriptionStatuses: async () => {
        providerCalls += 1;
        await gate;
        return appleStatuses({ status: 1, signedLatest: "fresh" });
      },
    } as never);

    const runnerA = runReclaimReconciliationSweep();
    await vi.waitFor(() => {
      expect(providerCalls).toBeGreaterThan(0);
    });
    const runnerB = await runReclaimReconciliationSweep();
    expect(runnerB.leaseAcquired).toBe(false);
    expect(runnerB.driftChecked).toBe(0);
    release();
    const resultA = await runnerA;
    expect(resultA.leaseAcquired).toBe(true);
    expect(resultA.driftChecked).toBe(1);
    // Exactly one runner made provider calls.
    expect(providerCalls).toBe(1);
  });
});

describe("expired-custody compensation", () => {
  test("a lost terminal event just after period end still claws the unspent remainder", async () => {
    const { claimer } = await createRestoredSubscription();
    expect(await getBalance(claimer)).toBe(PERIOD_CREDITS);

    // The restored period expired a minute before this sweep and the
    // terminal webhook was lost: no custody covers "now" any more.
    const custody = await prisma.lineagePeriodCustody.findFirstOrThrow({});
    await prisma.lineagePeriodCustody.update({
      where: { id: custody.id },
      data: { periodEnd: new Date(Date.now() - 60_000) },
    });
    installAppleStatuses({ status: 2, signedLatest: "irrelevant" });

    const counts = await runReclaimReconciliationSweep();
    expect(counts.driftChecked).toBe(1);
    // A covering-now lookup alone would have found nothing and left the
    // unspent value with the holder forever.
    expect(counts.driftCompensated).toBe(1);
    expect(await getBalance(claimer)).toBe(0n);
    const settled = await prisma.lineagePeriodCustody.findUniqueOrThrow({
      where: { id: custody.id },
    });
    expect(settled.state).toBe("invalidated");
    const row = await prisma.subscription.findFirstOrThrow({
      where: { originalTransactionId: OTX },
    });
    expect(row.status).toBe(SubscriptionStatus.expired);
  });
});

describe("restoration with no matching funding event", () => {
  test("parks the lineage and rejects instead of restoring zero credits", async () => {
    installLocalTestingVerifier();
    __setClaimAppCheckVerifierForTests(() => Promise.resolve());
    const owner = await newAccount();
    await upsertFromVerify(appleInput(owner));
    await deleteAccount({ accountId: owner, operationId: randomUUID() });

    // A renewal happened while tombstoned but its notification was lost: no
    // escrow row exists for the current funding event the claim presents.
    const renewalTxn = "6000000000000099";
    const jws = await signTransaction({
      transactionId: renewalTxn,
      purchaseDate: PERIOD_END.getTime(),
      expiresDate: NEXT_PERIOD_END.getTime(),
    });
    installAppleStatuses({ status: 1, signedLatest: jws });
    const claimer = await newAccount();
    const res = await appleClaimRequest(claimer, jws);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      code: "subscription_claim_rejected",
      reason: "lineage_unresolved",
    });

    // Fail closed: no live lineage with zero credits was minted.
    expect(await getBalance(claimer)).toBe(0n);
    expect(await prisma.subscription.count()).toBe(0);
    const lineage = await prisma.subscriptionLineage.findFirstOrThrow({
      where: { lineageKey: OTX },
    });
    expect(lineage.state).toBe("tombstoned");
    const escrow = await prisma.lineagePeriodCustody.findFirstOrThrow({
      where: { providerPeriodKey: `apple_txn_${OTX}` },
    });
    expect(escrow.state).toBe("escrow");
    // Parked (with alert) for an operator/backfill.
    const parked = await prisma.lineageQuarantine.findMany({
      where: { reason: "restoration_missing_funding_event" },
    });
    expect(parked).toHaveLength(1);
    expect(parked[0].token).toBe(OTX);

    // A retried claim converges on the same parked row - no duplicates.
    const retry = await appleClaimRequest(claimer, jws);
    expect(retry.status).toBe(409);
    expect(
      await prisma.lineageQuarantine.count({
        where: { reason: "restoration_missing_funding_event" },
      }),
    ).toBe(1);
  });
});
