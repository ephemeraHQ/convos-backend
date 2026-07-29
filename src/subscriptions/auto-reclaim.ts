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
