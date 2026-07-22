import {
  LedgerReason,
  type LineagePeriodCustody,
  type Prisma,
} from "@prisma/client";
import { applyDeltaWithTx, lockUserCreditsBalance } from "@/payments/ledger";
import { subGrantKey, sumConsumesSince } from "@/subscriptions/grants";
import type { LineageLockContext } from "@/subscriptions/lineage";

type TxClient = Prisma.TransactionClient;

/**
 * Lineage-period custody: the escrow/held state machine that makes every
 * subscription-credit move conservative.
 *
 * Every operation runs under the lineage FOR UPDATE lock (the
 * LineageLockContext parameter is the type-level proof) and moves exactly
 *
 *   D = min(lockedOwnerBalance, max(0, cap - ownerConsumesSince(custodyStartedAt)))
 *
 * then sets cap := D. Because D <= cap and cap starts at the period
 * allotment, no chain of transfer/undo/escrow/refund can ever move more
 * value than the period funded, and commingled promo/admin/signup credits
 * never transfer (they are outside cap). After funding, custody — not
 * account-scoped sub_grant rows — is the source of truth for the remainder.
 */

export const CUSTODY_STATE_HELD = "held";
export const CUSTODY_STATE_ESCROW = "escrow";
export const CUSTODY_STATE_INVALIDATED = "invalidated";
export const CUSTODY_STATE_EXHAUSTED = "exhausted";

/**
 * Ordering guard for the deletion teardown: escrow settlement must run
 * BEFORE deleteWalletForAccountWithTx. A held custody's owner always has a
 * UserCredits row (funding created it), so a missing row here means the
 * teardown already tore the wallet down — proceeding would let the balance
 * lock silently recreate a zero wallet (conserving 0 and breaking the
 * Account delete on its RESTRICT FK). Fail loudly instead.
 */
export class EscrowWalletMissingError extends Error {
  constructor(accountId: string) {
    super(
      `escrowCustody: UserCredits row missing for holder ${accountId} — ` +
        "escrow must settle before the wallet teardown " +
        "(deleteWalletForAccountWithTx) in the deletion transaction",
    );
    Object.setPrototypeOf(this, EscrowWalletMissingError.prototype);
  }
}

export const findCustody = async (
  tx: TxClient,
  ctx: LineageLockContext,
  providerPeriodKey: string,
): Promise<LineagePeriodCustody | null> =>
  tx.lineagePeriodCustody.findUnique({
    where: {
      lineageId_providerPeriodKey: {
        lineageId: ctx.lineageId,
        providerPeriodKey,
      },
    },
  });

/** Custody row (if any) covering `at` for this lineage, preferring held/escrow. */
export const findCustodyCovering = async (
  tx: TxClient,
  ctx: LineageLockContext,
  at: Date,
  states: string[],
): Promise<LineagePeriodCustody | null> =>
  tx.lineagePeriodCustody.findFirst({
    where: {
      lineageId: ctx.lineageId,
      state: { in: states },
      periodStart: { lte: at },
      periodEnd: { gt: at },
    },
    orderBy: { periodStart: "desc" },
  });

/** Create the held custody row for a freshly funded period. */
export const createHeldCustody = async (
  tx: TxClient,
  ctx: LineageLockContext,
  args: {
    providerPeriodKey: string;
    ownerAccountId: string;
    credits: bigint;
    periodStart: Date;
    periodEnd: Date;
  },
): Promise<LineagePeriodCustody> =>
  tx.lineagePeriodCustody.create({
    data: {
      lineageId: ctx.lineageId,
      providerPeriodKey: args.providerPeriodKey,
      ownerAccountId: args.ownerAccountId,
      remainderCap: args.credits,
      custodyStartedAt: new Date(),
      periodStart: args.periodStart,
      periodEnd: args.periodEnd,
      state: CUSTODY_STATE_HELD,
    },
  });

/** Create an escrow custody row directly (renewal while tombstoned). */
export const createEscrowCustody = async (
  tx: TxClient,
  ctx: LineageLockContext,
  args: {
    providerPeriodKey: string;
    credits: bigint;
    periodStart: Date;
    periodEnd: Date;
  },
): Promise<LineagePeriodCustody> =>
  tx.lineagePeriodCustody.create({
    data: {
      lineageId: ctx.lineageId,
      providerPeriodKey: args.providerPeriodKey,
      ownerAccountId: null,
      remainderCap: args.credits,
      custodyStartedAt: new Date(),
      periodStart: args.periodStart,
      periodEnd: args.periodEnd,
      state: CUSTODY_STATE_ESCROW,
    },
  });

/**
 * Bootstrap a custody row for a period funded before the lineage tables
 * existed: cap comes from the account-scoped sub_grant ledger row (the exact
 * base the pre-lineage forfeit used), consumes counted from period start.
 */
export const bootstrapLegacyCustody = async (
  tx: TxClient,
  ctx: LineageLockContext,
  args: {
    subscriptionId: string;
    ownerAccountId: string;
    periodStart: Date;
    periodEnd: Date;
  },
): Promise<LineagePeriodCustody | null> => {
  const existing = await tx.lineagePeriodCustody.findFirst({
    where: { lineageId: ctx.lineageId, periodStart: args.periodStart },
  });
  if (existing) return existing;
  const grantRow = await tx.creditLedger.findUnique({
    where: {
      accountId_idempotencyKey: {
        accountId: args.ownerAccountId,
        idempotencyKey: subGrantKey(args.subscriptionId, args.periodStart),
      },
    },
  });
  if (!grantRow) return null;
  const cap = grantRow.delta < 0n ? -grantRow.delta : grantRow.delta;
  const providerPeriodKey = `legacy_${args.subscriptionId}_${Math.floor(
    args.periodStart.getTime() / 1000,
  )}`;
  // Keep the "every funded period has exactly one registry row" invariant:
  // the legacy period was funded pre-lineage, so its registry row is written
  // here (idempotently) when the custody row is bootstrapped.
  await tx.lineagePeriodGrant.createMany({
    data: [
      {
        lineageId: ctx.lineageId,
        providerPeriodKey,
        accountId: args.ownerAccountId,
        ledgerKey: grantRow.idempotencyKey,
      },
    ],
    skipDuplicates: true,
  });
  return tx.lineagePeriodCustody.create({
    data: {
      lineageId: ctx.lineageId,
      providerPeriodKey,
      ownerAccountId: args.ownerAccountId,
      remainderCap: cap,
      custodyStartedAt: args.periodStart,
      periodStart: args.periodStart,
      periodEnd: args.periodEnd,
      state: CUSTODY_STATE_HELD,
    },
  });
};

/** The conservative move amount for the current holder. */
const computeMoveAmount = async (
  tx: TxClient,
  custody: LineagePeriodCustody,
): Promise<bigint> => {
  if (!custody.ownerAccountId) return 0n;
  const lockedBalance = await lockUserCreditsBalance(
    tx,
    custody.ownerAccountId,
  );
  const consumed = BigInt(
    await sumConsumesSince(
      tx,
      custody.ownerAccountId,
      custody.custodyStartedAt,
    ),
  );
  const unspent =
    custody.remainderCap > consumed ? custody.remainderCap - consumed : 0n;
  const positiveBalance = lockedBalance > 0n ? lockedBalance : 0n;
  return unspent < positiveBalance ? unspent : positiveBalance;
};

/**
 * Live transfer: debit the current holder by D, credit the new owner by D
 * (invariant: the two deltas sum to zero), move custody.
 */
export const transferCustody = async (
  tx: TxClient,
  ctx: LineageLockContext,
  args: {
    custody: LineagePeriodCustody;
    toAccountId: string;
    journalId: string;
  },
): Promise<bigint> => {
  const { custody } = args;
  const fromAccountId = custody.ownerAccountId;
  if (!fromAccountId) return 0n;
  // Lock-order rule 4: prelock BOTH wallets in sorted account order before
  // any read or debit. Without this, an A->B transfer on one lineage and a
  // B->A transfer on another lock the two wallets in opposite orders and
  // deadlock (40P01).
  const walletLockOrder = [fromAccountId, args.toAccountId].sort();
  for (const accountId of walletLockOrder) {
    await lockUserCreditsBalance(tx, accountId);
  }
  const amount = await computeMoveAmount(tx, custody);
  if (amount > 0n) {
    await applyDeltaWithTx(tx, {
      accountId: fromAccountId,
      delta: -amount,
      reason: LedgerReason.adjust,
      idempotencyKey: `sub_transfer_out_${args.journalId}`,
      scope: "sub_transfer",
      grantKindId: "sub_forfeit",
      note: `lineage ${ctx.lineageId} transfer out (journal ${args.journalId})`,
      floorCheck: { minBalance: 0n },
    });
    await applyDeltaWithTx(tx, {
      accountId: args.toAccountId,
      delta: amount,
      reason: LedgerReason.grant,
      idempotencyKey: `sub_transfer_in_${args.journalId}`,
      scope: "sub_transfer",
      grantKindId: "sub_grant",
      note: `lineage ${ctx.lineageId} transfer in (journal ${args.journalId})`,
    });
  }
  await tx.lineagePeriodCustody.update({
    where: { id: custody.id },
    data: {
      ownerAccountId: args.toAccountId,
      remainderCap: amount,
      custodyStartedAt: new Date(),
      state: CUSTODY_STATE_HELD,
    },
  });
  return amount;
};

/**
 * Deletion escrow: debit the holder by D into escrow (the tombstone
 * snapshot, first-class). The wallet is removed later in the same teardown.
 */
export const escrowCustody = async (
  tx: TxClient,
  ctx: LineageLockContext,
  args: { custody: LineagePeriodCustody; journalId: string },
): Promise<bigint> => {
  const { custody } = args;
  const fromAccountId = custody.ownerAccountId;
  if (!fromAccountId) return custody.remainderCap;
  // Escrow-before-teardown assertion (see EscrowWalletMissingError): check
  // the wallet row exists BEFORE computeMoveAmount's lock upserts one.
  const wallet = await tx.userCredits.findUnique({
    where: { accountId: fromAccountId },
    select: { accountId: true },
  });
  if (!wallet) throw new EscrowWalletMissingError(fromAccountId);
  const amount = await computeMoveAmount(tx, custody);
  if (amount > 0n) {
    await applyDeltaWithTx(tx, {
      accountId: fromAccountId,
      delta: -amount,
      reason: LedgerReason.adjust,
      idempotencyKey: `sub_escrow_out_${args.journalId}`,
      scope: "sub_transfer",
      grantKindId: "sub_forfeit",
      note: `lineage ${ctx.lineageId} escrow (journal ${args.journalId})`,
      floorCheck: { minBalance: 0n },
    });
  }
  await tx.lineagePeriodCustody.update({
    where: { id: custody.id },
    data: {
      ownerAccountId: null,
      remainderCap: amount,
      custodyStartedAt: new Date(),
      state: CUSTODY_STATE_ESCROW,
    },
  });
  return amount;
};

/**
 * Tombstone restoration: release the escrowed remainder to the claimant.
 * This is not a grant — the period's funding-registry row already exists;
 * the release references it via the custody row. cap is unchanged.
 */
export const releaseCustody = async (
  tx: TxClient,
  ctx: LineageLockContext,
  args: {
    custody: LineagePeriodCustody;
    toAccountId: string;
    journalId: string;
  },
): Promise<bigint> => {
  const { custody } = args;
  const amount = custody.remainderCap > 0n ? custody.remainderCap : 0n;
  if (amount > 0n) {
    await applyDeltaWithTx(tx, {
      accountId: args.toAccountId,
      delta: amount,
      reason: LedgerReason.grant,
      idempotencyKey: `sub_escrow_release_${args.journalId}`,
      scope: "sub_transfer",
      grantKindId: "sub_grant",
      note: `lineage ${ctx.lineageId} escrow release (journal ${args.journalId})`,
    });
  }
  await tx.lineagePeriodCustody.update({
    where: { id: custody.id },
    data: {
      ownerAccountId: args.toAccountId,
      custodyStartedAt: new Date(),
      state: CUSTODY_STATE_HELD,
    },
  });
  return amount;
};

/**
 * Refund/revoke compensation: claw the conservative remainder back from the
 * current holder (works whether they hold sub_grant or sub_transfer_in
 * value); escrowed custody is invalidated without any wallet move (the value
 * already left at deletion time).
 */
export const invalidateCustody = async (
  tx: TxClient,
  ctx: LineageLockContext,
  args: { custody: LineagePeriodCustody; journalId: string },
): Promise<bigint> => {
  const { custody } = args;
  let moved = 0n;
  if (custody.state === CUSTODY_STATE_HELD && custody.ownerAccountId) {
    const amount = await computeMoveAmount(tx, custody);
    if (amount > 0n) {
      await applyDeltaWithTx(tx, {
        accountId: custody.ownerAccountId,
        delta: -amount,
        reason: LedgerReason.adjust,
        idempotencyKey: `sub_refund_out_${args.journalId}`,
        scope: "sub_transfer",
        grantKindId: "sub_forfeit",
        note: `lineage ${ctx.lineageId} refund compensation (journal ${args.journalId})`,
        floorCheck: { minBalance: 0n },
      });
      moved = amount;
    }
  }
  await tx.lineagePeriodCustody.update({
    where: { id: custody.id },
    data: { remainderCap: 0n, state: CUSTODY_STATE_INVALIDATED },
  });
  return moved;
};

/** Past-period escrow rows release nothing; mark them exhausted. */
export const exhaustCustody = async (
  tx: TxClient,
  custody: LineagePeriodCustody,
): Promise<void> => {
  await tx.lineagePeriodCustody.update({
    where: { id: custody.id },
    data: { remainderCap: 0n, state: CUSTODY_STATE_EXHAUSTED },
  });
};
