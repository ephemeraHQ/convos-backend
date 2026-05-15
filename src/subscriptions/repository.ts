import {
  Prisma,
  SubscriptionStatus,
  type AppleEnv,
  type AppleReceipt,
  type Subscription,
  type SubscriptionPeriod,
  type SubscriptionTier,
} from "@prisma/client";
import { prisma } from "@/utils/prisma";

export type { Subscription, AppleReceipt };
export {
  AppleEnv,
  SubscriptionPeriod,
  SubscriptionStatus,
  SubscriptionTier,
} from "@prisma/client";

const ACTIVE_STATUSES: SubscriptionStatus[] = [
  SubscriptionStatus.trial,
  SubscriptionStatus.active,
  SubscriptionStatus.grace,
  SubscriptionStatus.billingRetry,
];

/**
 * Find the subscription a caller would see as "current" — preferring an
 * active/trial/grace/billing-retry row, otherwise falling back to the most
 * recent expired/revoked one so the UI can still show recent state.
 *
 * Returns null only when the account has never had a subscription.
 */
export const findCurrentByAccountId = async (
  accountId: string,
): Promise<Subscription | null> => {
  const active = await prisma.subscription.findFirst({
    where: { accountId, status: { in: ACTIVE_STATUSES } },
    orderBy: { updatedAt: "desc" },
  });
  if (active) return active;
  return prisma.subscription.findFirst({
    where: { accountId },
    orderBy: { updatedAt: "desc" },
  });
};

export const findByOriginalTransactionId = async (
  originalTransactionId: string,
): Promise<Subscription | null> =>
  prisma.subscription.findUnique({ where: { originalTransactionId } });

export const findReceiptByTransactionId = async (
  transactionId: string,
): Promise<AppleReceipt | null> =>
  prisma.appleReceipt.findUnique({ where: { transactionId } });

export type VerifyInput = {
  accountId: string;
  appAccountToken: string;
  productId: string;
  tier: SubscriptionTier;
  period: SubscriptionPeriod;
  status: SubscriptionStatus;
  originalTransactionId: string;
  transactionId: string;
  startedAt: Date;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  willRenew: boolean;
  isInTrial: boolean;
  environment: AppleEnv;
  signedPayload: string;
};

export type VerifyResult = {
  subscription: Subscription;
  /** True when this transactionId was new (first time we've seen it). */
  receiptCreated: boolean;
};

/**
 * Idempotent verify upsert. Single tx that:
 *   1. Creates the Subscription if originalTransactionId is new, or updates
 *      its mutable fields if it already exists (tier upgrades, state
 *      transitions, and `accountId` re-assignment for cross-device transfer
 *      per PRD §6.4).
 *   2. Records the AppleReceipt audit row keyed on transactionId. If we've
 *      already processed this exact transaction, the row is left untouched
 *      and `receiptCreated` is false — the caller can short-circuit.
 */
export const upsertFromVerify = async (
  input: VerifyInput,
): Promise<VerifyResult> => {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.subscription.findUnique({
      where: { originalTransactionId: input.originalTransactionId },
    });

    const subscription = existing
      ? await tx.subscription.update({
          where: { id: existing.id },
          data: {
            accountId: input.accountId,
            appAccountToken: input.appAccountToken,
            productId: input.productId,
            tier: input.tier,
            period: input.period,
            status: input.status,
            currentPeriodStart: input.currentPeriodStart,
            currentPeriodEnd: input.currentPeriodEnd,
            willRenew: input.willRenew,
            isInTrial: input.isInTrial,
            environment: input.environment,
          },
        })
      : await tx.subscription.create({
          data: {
            accountId: input.accountId,
            appAccountToken: input.appAccountToken,
            productId: input.productId,
            tier: input.tier,
            period: input.period,
            status: input.status,
            originalTransactionId: input.originalTransactionId,
            startedAt: input.startedAt,
            currentPeriodStart: input.currentPeriodStart,
            currentPeriodEnd: input.currentPeriodEnd,
            willRenew: input.willRenew,
            isInTrial: input.isInTrial,
            environment: input.environment,
          },
        });

    const existingReceipt = await tx.appleReceipt.findUnique({
      where: { transactionId: input.transactionId },
    });

    if (existingReceipt) {
      return { subscription, receiptCreated: false };
    }

    await tx.appleReceipt.create({
      data: {
        subscriptionId: subscription.id,
        transactionId: input.transactionId,
        notificationType: "VERIFY",
        signedPayload: input.signedPayload,
      },
    });

    return { subscription, receiptCreated: true };
  });
};

export type NotificationStateUpdate = {
  status?: SubscriptionStatus;
  currentPeriodStart?: Date;
  currentPeriodEnd?: Date;
  willRenew?: boolean;
  isInTrial?: boolean;
  cancelledAt?: Date | null;
  gracePeriodEnd?: Date | null;
  productId?: string;
  tier?: SubscriptionTier;
};

export type ApplyNotificationInput = {
  originalTransactionId: string;
  transactionId: string;
  notificationType: string;
  notificationSubtype?: string | null;
  signedPayload: string;
  update: NotificationStateUpdate;
};

export type ApplyNotificationResult =
  | { kind: "replayed"; subscription: Subscription }
  | { kind: "applied"; subscription: Subscription }
  | { kind: "unknown_subscription" };

/**
 * Apply an Apple S2S notification atomically:
 *   1. Look up the subscription by originalTransactionId. If unknown, return
 *      "unknown_subscription" — the caller decides how to recover (typically
 *      fetching from the App Store Server API and bootstrapping a row).
 *   2. Insert the AppleReceipt row keyed on transactionId. A P2002 unique
 *      violation means we've already processed this exact notification — we
 *      return "replayed" with the current sub state and do not re-apply any
 *      state changes.
 *   3. Apply the state update to the Subscription row.
 */
export const applyNotification = async (
  input: ApplyNotificationInput,
): Promise<ApplyNotificationResult> => {
  const subscription = await prisma.subscription.findUnique({
    where: { originalTransactionId: input.originalTransactionId },
  });
  if (!subscription) {
    return { kind: "unknown_subscription" };
  }

  try {
    return await prisma.$transaction(async (tx) => {
      await tx.appleReceipt.create({
        data: {
          subscriptionId: subscription.id,
          transactionId: input.transactionId,
          notificationType: input.notificationType,
          notificationSubtype: input.notificationSubtype ?? null,
          signedPayload: input.signedPayload,
        },
      });

      const updated = await tx.subscription.update({
        where: { id: subscription.id },
        data: input.update,
      });

      return { kind: "applied" as const, subscription: updated };
    });
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      const current = await prisma.subscription.findUnique({
        where: { id: subscription.id },
      });
      if (current) {
        return { kind: "replayed", subscription: current };
      }
    }
    throw err;
  }
};

export type UserSubscriptionDto = {
  tier: SubscriptionTier;
  period: SubscriptionPeriod;
  status: SubscriptionStatus;
  productId: string;
  currentPeriodEnd: string;
  willRenew: boolean;
  isInTrial: boolean;
};

export const serializeUserSubscription = (
  subscription: Subscription,
): UserSubscriptionDto => ({
  tier: subscription.tier,
  period: subscription.period,
  status: subscription.status,
  productId: subscription.productId,
  currentPeriodEnd: subscription.currentPeriodEnd.toISOString(),
  willRenew: subscription.willRenew,
  isInTrial: subscription.isInTrial,
});
