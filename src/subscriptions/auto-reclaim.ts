import { BillingProvider, LedgerReason, type Prisma } from "@prisma/client";
import type { Logger } from "pino";
import type { VerifyInput } from "@/subscriptions/repository";
import { isEntitledSubscriptionStatus } from "@/subscriptions/status";
import { prisma } from "@/utils/prisma";

export type IneligibleReason =
  | "disabled"
  | "provider_not_supported"
  | "not_purchased_ownership"
  | "stale_jws"
  | "not_entitled"
  | "holder_active"
  | "cooldown"
  | "holder_changed";

export type AutoReclaimResult =
  | { eligible: false; reason: IneligibleReason }
  | {
      eligible: true;
      previousAccountId: string;
      subscriptionId: string;
    };

type LockedSubscriptionOwner = {
  id: string;
  accountId: string;
};

const numericEnv = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const lockSubscriptionOwner = async (
  tx: Prisma.TransactionClient,
  subscriptionId: string,
): Promise<LockedSubscriptionOwner | null> => {
  const rows = await tx.$queryRaw<LockedSubscriptionOwner[]>`
    SELECT "id", "accountId"
    FROM "Subscription"
    WHERE "id" = ${subscriptionId}::uuid
    FOR UPDATE
  `;
  return rows[0] ?? null;
};

/**
 * Guarded, audited, single-transaction transfer of an Apple Subscription row
 * from a DORMANT holder to the verifying claimant, evaluated only at the
 * verify account-mismatch 409. Every guard fails CLOSED to the existing 409.
 *
 * KNOWN RESIDUAL RISKS (why this is gated off by default via
 * SUBSCRIPTION_AUTO_RECLAIM_ENABLED, and must stay off until the deeper fixes
 * land):
 *
 *  - BEARER-JWS SCOPE (tracked to #377): possession of a fresh (<24h),
 *    PURCHASED, entitled JWS is treated as sufficient proof to move the row off
 *    a dormant holder. The claimant is NOT cryptographically bound to the
 *    signed appAccountToken, so a leaked/stolen fresh JWS replayed by another
 *    authenticated account CAN move the subscription — this is the same
 *    session-stealing surface the plain 409 was designed to block, deliberately
 *    pierced for the dormant-reinstall case. The dormancy signals here (VERIFY
 *    receipts, consume ledger rows, device updates) do NOT include ordinary
 *    authenticated reads, so an active-reader / non-writer holder can look
 *    dormant. The real hardening is #377's per-request activity stamp
 *    (Account.lastAuthAt) + a possession/contest step; do not enable this flag
 *    in prod until that exists.
 *  - STRANDED PERIOD CREDITS (tracked to #374 lineage custody): the transfer
 *    moves ONLY Subscription.accountId. A period already granted to the old
 *    holder stays in the old wallet, and a later forfeit (refund/expiry) runs
 *    against the NEW owner and cannot claw the old one back
 *    (skipped_nothing_to_forfeit). Bounded to at most one period's grant per
 *    transfer; this mirrors the drift the interim/manual re-home path already
 *    accepts. #374's LineagePeriodCustody is the correct escrow fix.
 *
 * The SEQUENTIAL client flow (the real ~15s iOS re-verify loop) is fully
 * protected against double-minting a transferred period by the durable
 * previous-holder guard in grantSubscriptionPeriod.
 */
export const attemptAutoReclaim = async (args: {
  input: VerifyInput;
  decoded: {
    inAppOwnershipType?: string;
    signedDate?: number;
  };
  expectedHolderAccountId: string;
  log: Logger;
}): Promise<AutoReclaimResult> => {
  const { input, decoded, expectedHolderAccountId } = args;

  if (process.env.SUBSCRIPTION_AUTO_RECLAIM_ENABLED !== "true") {
    return { eligible: false, reason: "disabled" };
  }
  if (input.provider !== BillingProvider.apple) {
    return { eligible: false, reason: "provider_not_supported" };
  }
  if (decoded.inAppOwnershipType !== "PURCHASED") {
    return { eligible: false, reason: "not_purchased_ownership" };
  }

  const now = new Date();
  const signedDate = decoded.signedDate;
  const maxJwsAgeMs =
    numericEnv("SUBSCRIPTION_AUTO_RECLAIM_MAX_JWS_AGE_HOURS", 24) *
    60 *
    60 *
    1000;
  if (
    signedDate === undefined ||
    !Number.isFinite(signedDate) ||
    now.getTime() - signedDate > maxJwsAgeMs
  ) {
    return { eligible: false, reason: "stale_jws" };
  }
  if (
    !isEntitledSubscriptionStatus(input.status) ||
    input.currentPeriodEnd <= now
  ) {
    return { eligible: false, reason: "not_entitled" };
  }

  const dormancyCutoff = new Date(
    now.getTime() -
      numericEnv("SUBSCRIPTION_AUTO_RECLAIM_DORMANCY_DAYS", 7) *
        24 *
        60 *
        60 *
        1000,
  );
  const [recentVerify, recentConsume, recentDevice] = await Promise.all([
    prisma.billingReceipt.findFirst({
      where: {
        notificationType: "VERIFY",
        receivedAt: { gt: dormancyCutoff },
        subscription: { accountId: expectedHolderAccountId },
      },
      select: { id: true },
    }),
    prisma.creditLedger.findFirst({
      where: {
        accountId: expectedHolderAccountId,
        reason: LedgerReason.consume,
        createdAt: { gt: dormancyCutoff },
      },
      select: { id: true },
    }),
    prisma.deviceRegistration.findFirst({
      where: {
        accountId: expectedHolderAccountId,
        updatedAt: { gt: dormancyCutoff },
      },
      select: { deviceId: true },
    }),
  ]);
  if (recentVerify || recentConsume || recentDevice) {
    return { eligible: false, reason: "holder_active" };
  }

  return prisma.$transaction(async (tx): Promise<AutoReclaimResult> => {
    const subscription = await tx.subscription.findUnique({
      where: {
        subscription_apple_otx_unique: {
          provider: BillingProvider.apple,
          originalTransactionId: input.originalTransactionId,
        },
      },
      select: { id: true, accountId: true },
    });
    if (!subscription || subscription.accountId !== expectedHolderAccountId) {
      return { eligible: false, reason: "holder_changed" };
    }

    const locked = await lockSubscriptionOwner(tx, subscription.id);
    if (!locked || locked.accountId !== expectedHolderAccountId) {
      return { eligible: false, reason: "holder_changed" };
    }

    const cooldownCutoff = new Date(
      now.getTime() -
        numericEnv("SUBSCRIPTION_AUTO_RECLAIM_COOLDOWN_DAYS", 7) *
          24 *
          60 *
          60 *
          1000,
    );
    const recentTransfer = await tx.adminAudit.findFirst({
      where: {
        action: "auto_reclaim_transfer",
        idempotencyKey: {
          startsWith: `auto_reclaim_apple_${input.originalTransactionId}_`,
        },
        createdAt: { gte: cooldownCutoff },
      },
      select: { id: true },
    });
    if (recentTransfer) {
      return { eligible: false, reason: "cooldown" };
    }

    const transferred = await tx.subscription.updateMany({
      where: {
        id: locked.id,
        provider: BillingProvider.apple,
        originalTransactionId: input.originalTransactionId,
        accountId: expectedHolderAccountId,
      },
      data: { accountId: input.accountId },
    });
    if (transferred.count !== 1) {
      return { eligible: false, reason: "holder_changed" };
    }

    const signedAt = new Date(signedDate);
    await tx.adminAudit.create({
      data: {
        accountId: input.accountId,
        actorEmail: "system:auto-reclaim",
        action: "auto_reclaim_transfer",
        deltaCredits: 0n,
        reason:
          `Auto-reclaimed Apple subscription otx=${input.originalTransactionId} ` +
          `subscriptionId=${locked.id} from=${expectedHolderAccountId} ` +
          `to=${input.accountId} jwsSignedAt=${signedAt.toISOString()}`,
        idempotencyKey:
          `auto_reclaim_apple_${input.originalTransactionId}_` +
          `${expectedHolderAccountId}_${now.getTime()}`,
      },
    });

    return {
      eligible: true,
      previousAccountId: expectedHolderAccountId,
      subscriptionId: locked.id,
    };
  });
};
