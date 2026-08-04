import { readFileSync } from "node:fs";
import { BillingProvider, type Prisma } from "@prisma/client";
import { describe, expect, test } from "vitest";
import {
  SubscriptionPeriod,
  SubscriptionStatus,
} from "@/subscriptions/repository";
import { prisma } from "@/utils/prisma";
import {
  installReclaimHooks,
  newAccount,
  NEXT_PERIOD_END,
  PERIOD_END,
  PERIOD_START,
  PRODUCT_ID,
} from "./reclaim-fixtures";

/**
 * Data-shape tests for the lineage backfill in
 * 20260715104500_add_subscription_lineage. The migration already ran against
 * the test database, so each test replays the backfill statements against
 * freshly seeded legacy-shaped rows inside a transaction that is always
 * rolled back (the unique lineage index is dropped and re-created by the
 * replayed statements themselves).
 */

installReclaimHooks();

const MIGRATION_URL = new URL(
  "../../prisma/migrations/20260715104500_add_subscription_lineage/migration.sql",
  import.meta.url,
);

/** Split a SQL block into statements, honoring $$ bodies and -- comments. */
const splitSqlStatements = (block: string): string[] => {
  const statements: string[] = [];
  let current = "";
  let inDollarQuote = false;
  let inLineComment = false;
  for (let i = 0; i < block.length; i += 1) {
    const ch = block[i];
    if (inLineComment) {
      if (ch === "\n") inLineComment = false;
      current += ch;
      continue;
    }
    if (!inDollarQuote && block.startsWith("--", i)) {
      inLineComment = true;
      current += ch;
      continue;
    }
    if (block.startsWith("$$", i)) {
      inDollarQuote = !inDollarQuote;
      current += "$$";
      i += 1;
      continue;
    }
    if (ch === ";" && !inDollarQuote) {
      if (current.trim().length > 0) statements.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim().length > 0) statements.push(current.trim());
  return statements;
};

const isCommentOnly = (statement: string): boolean =>
  statement
    .split("\n")
    .every((line) => line.trim() === "" || line.trim().startsWith("--"));

const loadBackfillStatements = (): string[] => {
  const sql = readFileSync(MIGRATION_URL, "utf8");
  const start = sql.indexOf("-- Backfill:");
  const end = sql.indexOf("-- Widen the ledger scope");
  if (start < 0 || end < 0 || end <= start) {
    throw new Error("backfill section not found in migration.sql");
  }
  return splitSqlStatements(sql.slice(start, end)).filter(
    (statement) => !isCommentOnly(statement),
  );
};

const backfillStatements = loadBackfillStatements();

/**
 * Replay the backfill inside `tx`. The replayed statements scan whole
 * tables, so rows left behind by other test files are removed first (the
 * transaction always rolls back, so the scrub never leaks). The applied
 * migration already created the one-row-per-lineage unique index, so it is
 * dropped up front; the replayed statements re-create it after
 * consolidating, exactly like the real run.
 */
const replayBackfill = async (
  tx: Prisma.TransactionClient,
  keepSubscriptionIds: string[],
): Promise<void> => {
  await tx.billingReceipt.deleteMany({
    where: { subscriptionId: { notIn: keepSubscriptionIds } },
  });
  await tx.subscription.deleteMany({
    where: { id: { notIn: keepSubscriptionIds } },
  });
  await tx.lineageTokenAlias.deleteMany({});
  await tx.lineageQuarantine.deleteMany({});
  await tx.subscriptionLineage.deleteMany({});
  await tx.subscriptionTombstone.deleteMany({});
  await tx.$executeRawUnsafe('DROP INDEX "Subscription_lineageId_key"');
  for (const statement of backfillStatements) {
    await tx.$executeRawUnsafe(statement);
  }
};

/** Sentinel that always rolls the replay transaction back. */
class Rollback extends Error {}

const inRolledBackTx = async (
  fn: (tx: Prisma.TransactionClient) => Promise<void>,
): Promise<void> => {
  await prisma
    .$transaction(
      async (tx) => {
        await fn(tx);
        throw new Rollback("rollback");
      },
      { timeout: 30_000 },
    )
    .catch((err: unknown) => {
      if (!(err instanceof Rollback)) throw err;
    });
};

const seedGoogleRow = async (args: {
  accountId: string;
  purchaseToken: string | null;
  linkedPurchaseToken?: string | null;
  currentPeriodEnd?: Date;
}) =>
  prisma.subscription.create({
    data: {
      accountId: args.accountId,
      provider: BillingProvider.googlePlay,
      productId: PRODUCT_ID,
      tier: "plus",
      period: SubscriptionPeriod.monthly,
      status: SubscriptionStatus.active,
      purchaseToken: args.purchaseToken,
      linkedPurchaseToken: args.linkedPurchaseToken ?? null,
      obfuscatedAccountId: `oid-${args.purchaseToken ?? args.linkedPurchaseToken}`,
      startedAt: PERIOD_START,
      currentPeriodStart: PERIOD_START,
      currentPeriodEnd: args.currentPeriodEnd ?? PERIOD_END,
    },
  });

const seedReceipt = async (subscriptionId: string, orderId: string) =>
  prisma.billingReceipt.create({
    data: {
      subscriptionId,
      provider: BillingProvider.googlePlay,
      idempotencyKey: `play-verify:${orderId}`,
      transactionId: orderId,
      notificationType: "VERIFY",
      signedPayload: "{}",
    },
  });

describe("google lineage backfill root canonicalization", () => {
  test("a twice-rotated chain keys one lineage on the true root and consolidates onto the newest row", async () => {
    const owner = await newAccount();
    // Chain a <- b <- c: the root token "mig-a" has no row of its own (its
    // identity is known only from b's predecessor pointer), b was rotated to
    // c. Predecessor-only keying would mint TWO lineages (keys "mig-a" and
    // "mig-b") for one purchase line.
    const rowB = await seedGoogleRow({
      accountId: owner,
      purchaseToken: "mig-b",
      linkedPurchaseToken: "mig-a",
      currentPeriodEnd: PERIOD_END,
    });
    const rowC = await seedGoogleRow({
      accountId: owner,
      purchaseToken: "mig-c",
      linkedPurchaseToken: "mig-b",
      currentPeriodEnd: NEXT_PERIOD_END,
    });
    const receiptB = await seedReceipt(rowB.id, "GPA.mig..1");
    const receiptC = await seedReceipt(rowC.id, "GPA.mig..2");

    await inRolledBackTx(async (tx) => {
      await replayBackfill(tx, [rowB.id, rowC.id]);

      // Exactly one monetary identity, keyed on the chain root.
      const lineages = await tx.subscriptionLineage.findMany({
        where: { provider: BillingProvider.googlePlay },
      });
      expect(lineages).toHaveLength(1);
      expect(lineages[0].lineageKey).toBe("mig-a");

      // Every chain member resolves to it.
      const aliases = await tx.lineageTokenAlias.findMany({
        orderBy: { token: "asc" },
      });
      expect(aliases.map((a) => a.token)).toEqual(["mig-a", "mig-b", "mig-c"]);
      expect(new Set(aliases.map((a) => a.lineageId))).toEqual(
        new Set([lineages[0].id]),
      );

      // Consolidation: the newest-entitlement row survives and carries the
      // lineage; the stale rotated row is gone, its receipt moved over.
      const rows = await tx.subscription.findMany({
        where: { provider: BillingProvider.googlePlay },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(rowC.id);
      expect(rows[0].lineageId).toBe(lineages[0].id);
      const receipts = await tx.billingReceipt.findMany({
        where: { id: { in: [receiptB.id, receiptC.id] } },
      });
      expect(receipts).toHaveLength(2);
      expect(new Set(receipts.map((r) => r.subscriptionId))).toEqual(
        new Set([rowC.id]),
      );

      // Nothing was ambiguous.
      expect(await tx.lineageQuarantine.count()).toBe(0);
    });
  });

  test("a predecessor known only from the successor's pointer becomes the root", async () => {
    const owner = await newAccount();
    const rowC = await seedGoogleRow({
      accountId: owner,
      purchaseToken: "orphan-c",
      linkedPurchaseToken: "orphan-b",
    });

    await inRolledBackTx(async (tx) => {
      await replayBackfill(tx, [rowC.id]);
      const lineage = await tx.subscriptionLineage.findFirstOrThrow({
        where: { provider: BillingProvider.googlePlay },
      });
      expect(lineage.lineageKey).toBe("orphan-b");
      const aliases = await tx.lineageTokenAlias.findMany({
        orderBy: { token: "asc" },
      });
      expect(aliases.map((a) => a.token)).toEqual(["orphan-b", "orphan-c"]);
      const row = await tx.subscription.findFirstOrThrow({
        where: { purchaseToken: "orphan-c" },
      });
      expect(row.lineageId).toBe(lineage.id);
    });
  });

  test("a cyclic chain is quarantined, never keyed", async () => {
    const owner = await newAccount();
    const rowA = await seedGoogleRow({
      accountId: owner,
      purchaseToken: "cyc-a",
      linkedPurchaseToken: "cyc-b",
    });
    const rowB = await seedGoogleRow({
      accountId: owner,
      purchaseToken: "cyc-b",
      linkedPurchaseToken: "cyc-a",
    });

    await inRolledBackTx(async (tx) => {
      await replayBackfill(tx, [rowA.id, rowB.id]);

      // No lineage, no alias, no lineageId was guessed for the cycle.
      expect(
        await tx.subscriptionLineage.count({
          where: { provider: BillingProvider.googlePlay },
        }),
      ).toBe(0);
      expect(await tx.lineageTokenAlias.count()).toBe(0);
      const rows = await tx.subscription.findMany({
        where: { id: { in: [rowA.id, rowB.id] } },
      });
      expect(rows.map((r) => r.lineageId)).toEqual([null, null]);

      // Both rows are parked for an operator with their walked chain.
      const parked = await tx.lineageQuarantine.findMany({
        where: { reason: "backfill_chain_unresolved" },
        orderBy: { token: "asc" },
      });
      expect(parked.map((q) => q.token)).toEqual(["cyc-a", "cyc-b"]);
    });
  });

  test("same-chain rows owned by different accounts fail the migration loudly", async () => {
    const ownerOne = await newAccount();
    const ownerTwo = await newAccount();
    const rowB = await seedGoogleRow({
      accountId: ownerOne,
      purchaseToken: "dup-b",
      linkedPurchaseToken: "dup-a",
    });
    const rowC = await seedGoogleRow({
      accountId: ownerTwo,
      purchaseToken: "dup-c",
      linkedPurchaseToken: "dup-b",
      currentPeriodEnd: NEXT_PERIOD_END,
    });

    await expect(
      prisma.$transaction(
        async (tx) => {
          await replayBackfill(tx, [rowB.id, rowC.id]);
        },
        { timeout: 30_000 },
      ),
    ).rejects.toThrow(/adjudicated/);

    // The failed transaction rolled everything back: rows intact, unkeyed,
    // and the unique index still in place.
    const rows = await prisma.subscription.findMany({
      where: { id: { in: [rowB.id, rowC.id] } },
    });
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.lineageId)).toEqual([null, null]);
    expect(
      await prisma.subscriptionLineage.count({
        where: { provider: BillingProvider.googlePlay },
      }),
    ).toBe(0);
    const indexes = await prisma.$queryRaw<Array<{ indexname: string }>>`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'Subscription' AND indexname = 'Subscription_lineageId_key'
    `;
    expect(indexes).toHaveLength(1);
  });
});
