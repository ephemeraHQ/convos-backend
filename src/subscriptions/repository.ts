import {
  BillingProvider,
  Prisma,
  SubscriptionStatus,
  type AppleEnv,
  type BillingReceipt,
  type Subscription,
  type SubscriptionPeriod,
} from "@prisma/client";
import {
  forfeitSubscriptionPeriod,
  grantSubscriptionPeriod,
} from "@/subscriptions/grants";
import {
  effectiveSubscriptionStatus,
  ENTITLED_SUBSCRIPTION_STATUSES,
  isEntitledSubscriptionStatus,
} from "@/subscriptions/status";
import {
  requireSubscriptionTier,
  SUBSCRIPTION_TIER_PLUS,
  type SubscriptionTier,
} from "@/subscriptions/tiers";
import { prisma } from "@/utils/prisma";

export type { Subscription, BillingReceipt, SubscriptionTier };
export { SUBSCRIPTION_TIER_PLUS };
export {
  AppleEnv,
  BillingProvider,
  SubscriptionPeriod,
  SubscriptionStatus,
} from "@prisma/client";

/**
 * Find the subscription a caller would see as "current" — preferring an
 * active/trial/grace/billing-retry row, otherwise falling back to the most
 * recent expired/revoked one so the UI can still show recent state.
 *
 * Cross-provider tiebreaker: when an account holds both an Apple and a Google
 * row, the entitled one with the later `currentPeriodEnd` wins naturally.
 *
 * Returns null only when the account has never had a subscription.
 */
export const findCurrentByAccountId = async (
  accountId: string,
): Promise<Subscription | null> => {
  const active = await prisma.subscription.findFirst({
    where: { accountId, status: { in: ENTITLED_SUBSCRIPTION_STATUSES } },
    orderBy: [{ currentPeriodEnd: "desc" }, { updatedAt: "desc" }],
  });
  if (active) return active;
  return prisma.subscription.findFirst({
    where: { accountId },
    orderBy: [{ currentPeriodEnd: "desc" }, { updatedAt: "desc" }],
  });
};

export const findAppleByOriginalTransactionId = async (
  originalTransactionId: string,
): Promise<Subscription | null> =>
  prisma.subscription.findUnique({
    where: {
      subscription_apple_otx_unique: {
        provider: BillingProvider.apple,
        originalTransactionId,
      },
    },
  });

/**
 * Find a Google Play subscription by its current purchaseToken. Play rotates
 * the token on upgrade/downgrade and carries the predecessor in
 * `linkedPurchaseToken`; this resolver falls through to that secondary index
 * so we can locate the row both before and after the rotation lands.
 */
export const findPlayByPurchaseToken = async (
  purchaseToken: string,
): Promise<Subscription | null> => {
  const direct = await prisma.subscription.findUnique({
    where: {
      subscription_play_token_unique: {
        provider: BillingProvider.googlePlay,
        purchaseToken,
      },
    },
  });
  if (direct) return direct;
  return prisma.subscription.findFirst({
    where: {
      provider: BillingProvider.googlePlay,
      linkedPurchaseToken: purchaseToken,
    },
  });
};

export const findReceiptByTransactionId = async (
  provider: BillingProvider,
  transactionId: string,
): Promise<BillingReceipt | null> =>
  prisma.billingReceipt.findFirst({
    where: { provider, transactionId },
    orderBy: { receivedAt: "asc" },
  });

export type AppleVerifyInput = {
  provider: typeof BillingProvider.apple;
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

export type GooglePlayVerifyInput = {
  provider: typeof BillingProvider.googlePlay;
  accountId: string;
  obfuscatedAccountId: string;
  productId: string;
  tier: SubscriptionTier;
  period: SubscriptionPeriod;
  status: SubscriptionStatus;
  purchaseToken: string;
  linkedPurchaseToken?: string | null;
  /** Google's per-order id from the fetched purchase. Used as the audit
   *  receipt's transactionId and to build the idempotency key. */
  playOrderId: string;
  startedAt: Date;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  willRenew: boolean;
  isInTrial: boolean;
  signedPayload: string;
};

export type VerifyInput = AppleVerifyInput | GooglePlayVerifyInput;

export type VerifyResult = {
  subscription: Subscription;
  /** True when this provider transaction was new (first time we've seen it). */
  receiptCreated: boolean;
};

/**
 * Thrown by upsertFromVerify when a caller authenticates as account B but
 * the persisted Subscription for the same provider+identifier is owned by
 * account A. The handler maps this to HTTP 409.
 */
export class SubscriptionAccountMismatchError extends Error {
  constructor(
    public readonly existingAccountId: string,
    public readonly attemptedAccountId: string,
    public readonly providerSubscriptionId: string,
  ) {
    super("Subscription belongs to a different account");
    this.name = "SubscriptionAccountMismatchError";
    Object.setPrototypeOf(this, SubscriptionAccountMismatchError.prototype);
  }
}

const appleVerifyIdempotencyKey = (transactionId: string) =>
  `apple-verify:${transactionId}`;

const playVerifyIdempotencyKey = (orderIdOrToken: string) =>
  `play-verify:${orderIdOrToken}`;

const appleNotificationIdempotencyKey = (notificationUUID: string) =>
  `apple-ssn:${notificationUUID}`;

const playRtdnIdempotencyKey = (messageId: string) => `play-rtdn:${messageId}`;

const providerSubscriptionId = (input: VerifyInput): string =>
  input.provider === BillingProvider.apple
    ? input.originalTransactionId
    : input.purchaseToken;

const findExistingForVerify = async (
  tx: Prisma.TransactionClient,
  input: VerifyInput,
): Promise<Subscription | null> => {
  if (input.provider === BillingProvider.apple) {
    return tx.subscription.findUnique({
      where: {
        subscription_apple_otx_unique: {
          provider: BillingProvider.apple,
          originalTransactionId: input.originalTransactionId,
        },
      },
    });
  }
  const direct = await tx.subscription.findUnique({
    where: {
      subscription_play_token_unique: {
        provider: BillingProvider.googlePlay,
        purchaseToken: input.purchaseToken,
      },
    },
  });
  if (direct || !input.linkedPurchaseToken) return direct;
  // Play rotates purchaseToken on upgrade/downgrade. When the rotated row
  // hasn't landed yet, the predecessor token still indexes the existing row.
  return tx.subscription.findUnique({
    where: {
      subscription_play_token_unique: {
        provider: BillingProvider.googlePlay,
        purchaseToken: input.linkedPurchaseToken,
      },
    },
  });
};

const reReadAfterRace = async (
  input: VerifyInput,
): Promise<Subscription | null> => {
  if (input.provider === BillingProvider.apple) {
    return prisma.subscription.findUnique({
      where: {
        subscription_apple_otx_unique: {
          provider: BillingProvider.apple,
          originalTransactionId: input.originalTransactionId,
        },
      },
    });
  }
  const direct = await prisma.subscription.findUnique({
    where: {
      subscription_play_token_unique: {
        provider: BillingProvider.googlePlay,
        purchaseToken: input.purchaseToken,
      },
    },
  });
  if (direct || !input.linkedPurchaseToken) return direct;
  return prisma.subscription.findUnique({
    where: {
      subscription_play_token_unique: {
        provider: BillingProvider.googlePlay,
        purchaseToken: input.linkedPurchaseToken,
      },
    },
  });
};

const verifyReceiptShape = (input: VerifyInput) => {
  if (input.provider === BillingProvider.apple) {
    return {
      idempotencyKey: appleVerifyIdempotencyKey(input.transactionId),
      transactionId: input.transactionId,
      notificationType: "VERIFY",
    };
  }
  return {
    idempotencyKey: playVerifyIdempotencyKey(input.playOrderId),
    transactionId: input.playOrderId,
    notificationType: "VERIFY",
  };
};

const subscriptionCreateData = (
  input: VerifyInput,
): Prisma.SubscriptionUncheckedCreateInput => {
  const base = {
    accountId: input.accountId,
    provider: input.provider,
    productId: input.productId,
    tier: input.tier,
    period: input.period,
    status: input.status,
    startedAt: input.startedAt,
    currentPeriodStart: input.currentPeriodStart,
    currentPeriodEnd: input.currentPeriodEnd,
    willRenew: input.willRenew,
    isInTrial: input.isInTrial,
  };
  if (input.provider === BillingProvider.apple) {
    return {
      ...base,
      originalTransactionId: input.originalTransactionId,
      appAccountToken: input.appAccountToken,
      environment: input.environment,
    };
  }
  return {
    ...base,
    purchaseToken: input.purchaseToken,
    linkedPurchaseToken: input.linkedPurchaseToken ?? null,
    obfuscatedAccountId: input.obfuscatedAccountId,
  };
};

const subscriptionUpdateData = (
  input: VerifyInput,
): Prisma.SubscriptionUncheckedUpdateInput => {
  const base = {
    productId: input.productId,
    tier: input.tier,
    period: input.period,
    status: input.status,
    currentPeriodStart: input.currentPeriodStart,
    currentPeriodEnd: input.currentPeriodEnd,
    willRenew: input.willRenew,
    isInTrial: input.isInTrial,
  };
  if (input.provider === BillingProvider.apple) {
    return {
      ...base,
      appAccountToken: input.appAccountToken,
      environment: input.environment,
    };
  }
  return {
    ...base,
    // purchaseToken rotates on upgrade/downgrade. If the caller is verifying
    // a new token whose linkedPurchaseToken matches our existing
    // purchaseToken, the new token wins and the old one is kept on
    // linkedPurchaseToken so we can still resolve replays.
    purchaseToken: input.purchaseToken,
    linkedPurchaseToken: input.linkedPurchaseToken ?? null,
    obfuscatedAccountId: input.obfuscatedAccountId,
  };
};

/**
 * Idempotent verify upsert. Single tx that:
 *   1. Reads the persisted Subscription (if any) and rejects with
 *      SubscriptionAccountMismatchError when its accountId differs from the
 *      caller's. Doing this read inside the transaction (rather than in the
 *      handler) closes a TOCTOU window between an outer ownership check and
 *      the update below — under READ COMMITTED two concurrent verifies for
 *      the same providerSubscriptionId could otherwise both see no conflict
 *      and the second overwrite the first's accountId.
 *   2. Short-circuits exact VERIFY replays (same provider+transactionId/
 *      orderId) before mutating Subscription state.
 *   3. Updates the existing Subscription's mutable fields (tier upgrades,
 *      state transitions, renewal window) or creates it if new. Stale replays
 *      do not roll currentPeriodEnd backwards.
 *   4. Records the BillingReceipt audit row keyed by idempotencyKey.
 *
 * The outer try/catch handles a remaining race window: when no row yet
 * exists, two cold-start verifies can both pass the ownership check
 * (existing === null) and both reach Subscription.create. Postgres
 * serializes them via the composite unique index; the loser's tx rolls back
 * with P2002 and lands here. We re-read the now-committed row and either
 * return idempotently (same accountId) or surface the mismatch.
 */
export const upsertFromVerify = async (
  input: VerifyInput,
): Promise<VerifyResult> => {
  const externalId = providerSubscriptionId(input);
  try {
    return await prisma.$transaction(async (tx) => {
      const existing = await findExistingForVerify(tx, input);

      if (existing && existing.accountId !== input.accountId) {
        throw new SubscriptionAccountMismatchError(
          existing.accountId,
          input.accountId,
          externalId,
        );
      }

      const receiptShape = verifyReceiptShape(input);
      const existingReceipt = await tx.billingReceipt.findUnique({
        where: { idempotencyKey: receiptShape.idempotencyKey },
        include: { subscription: true },
      });

      if (existingReceipt) {
        return {
          subscription: existingReceipt.subscription,
          receiptCreated: false,
        };
      }

      // A valid but old transaction can arrive after a later renewal/webhook.
      // Keep the audit row, but do not roll the subscription's entitlement
      // window or status backwards.
      const isStaleVerify =
        existing !== null && input.currentPeriodEnd < existing.currentPeriodEnd;

      const subscription = existing
        ? isStaleVerify
          ? existing
          : await tx.subscription.update({
              where: { id: existing.id },
              data: subscriptionUpdateData(input),
            })
        : await tx.subscription.create({
            data: subscriptionCreateData(input),
          });

      await tx.billingReceipt.create({
        data: {
          subscriptionId: subscription.id,
          provider: input.provider,
          idempotencyKey: receiptShape.idempotencyKey,
          transactionId: receiptShape.transactionId,
          notificationType: receiptShape.notificationType,
          signedPayload: input.signedPayload,
        },
      });

      // Single-ledger: materialize the period allotment as a real grant row.
      // Idempotent per (subscription, periodStart), so the initial verify, a
      // re-verify of the same period, or an S2S DID_RENEW racing this verify
      // all resolve to one row. Only grant when the verified state is
      // entitled and the verify is not a stale (out-of-order) replay.
      if (!isStaleVerify && isEntitledSubscriptionStatus(subscription.status)) {
        const grantResult = await grantSubscriptionPeriod(tx, {
          subscription,
          periodStart: subscription.currentPeriodStart,
        });
        // The grant wrote the credit row in the same tx; return the (current)
        // subscription so callers see consistent state.
        if (grantResult.kind === "granted") {
          return {
            subscription: grantResult.subscription,
            receiptCreated: true,
          };
        }
      }

      return { subscription, receiptCreated: true };
    });
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      const current = await reReadAfterRace(input);
      if (current) {
        if (current.accountId !== input.accountId) {
          throw new SubscriptionAccountMismatchError(
            current.accountId,
            input.accountId,
            externalId,
          );
        }
        return { subscription: current, receiptCreated: false };
      }
    }
    throw err;
  }
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
  /** Google-only: Play rotates purchaseToken on upgrade/downgrade. */
  purchaseToken?: string;
  linkedPurchaseToken?: string | null;
};

export type AppleApplyNotificationInput = {
  provider: typeof BillingProvider.apple;
  originalTransactionId: string;
  transactionId: string;
  notificationUUID: string;
  notificationType: string;
  notificationSubtype?: string | null;
  signedPayload: string;
  update: NotificationStateUpdate;
};

export type GooglePlayApplyNotificationInput = {
  provider: typeof BillingProvider.googlePlay;
  /** Lookup key — the purchaseToken from the RTDN payload. */
  purchaseToken: string;
  /** Audit transactionId — Google's latestOrderId from the refreshed purchase. */
  playOrderId: string;
  /** Pub/Sub messageId; used as the externalNotificationId for replay dedup. */
  messageId: string;
  notificationType: string;
  notificationSubtype?: string | null;
  signedPayload: string;
  update: NotificationStateUpdate;
};

export type ApplyNotificationInput =
  | AppleApplyNotificationInput
  | GooglePlayApplyNotificationInput;

export type ApplyNotificationResult =
  | { kind: "replayed"; subscription: Subscription }
  | { kind: "applied"; subscription: Subscription }
  | { kind: "unknown_subscription" };

const notificationLookup = (
  input: ApplyNotificationInput,
): Promise<Subscription | null> => {
  if (input.provider === BillingProvider.apple) {
    return findAppleByOriginalTransactionId(input.originalTransactionId);
  }
  return findPlayByPurchaseToken(input.purchaseToken);
};

const notificationReceiptShape = (input: ApplyNotificationInput) => {
  if (input.provider === BillingProvider.apple) {
    return {
      idempotencyKey: appleNotificationIdempotencyKey(input.notificationUUID),
      externalNotificationId: input.notificationUUID,
      transactionId: input.transactionId,
    };
  }
  return {
    idempotencyKey: playRtdnIdempotencyKey(input.messageId),
    externalNotificationId: input.messageId,
    transactionId: input.playOrderId,
  };
};

/**
 * Apply a provider notification atomically:
 *   1. Look up the subscription by provider-specific identifier. If unknown,
 *      return "unknown_subscription" — the caller decides how to recover
 *      (typically ack and let /verify create the row).
 *   2. Insert the BillingReceipt row keyed on the provider's external
 *      notification id. A P2002 unique violation means the provider retried
 *      the same notification — we return "replayed" with the current sub
 *      state and do not re-apply changes.
 *   3. Apply the state update to the Subscription row.
 */
export const applyNotification = async (
  input: ApplyNotificationInput,
): Promise<ApplyNotificationResult> => {
  const subscription = await notificationLookup(input);
  if (!subscription) {
    return { kind: "unknown_subscription" };
  }

  const receiptShape = notificationReceiptShape(input);

  try {
    return await prisma.$transaction(async (tx) => {
      await tx.billingReceipt.create({
        data: {
          subscriptionId: subscription.id,
          provider: input.provider,
          idempotencyKey: receiptShape.idempotencyKey,
          externalNotificationId: receiptShape.externalNotificationId,
          transactionId: receiptShape.transactionId,
          notificationType: input.notificationType,
          notificationSubtype: input.notificationSubtype ?? null,
          signedPayload: input.signedPayload,
        },
      });

      const updated = await tx.subscription.update({
        where: { id: subscription.id },
        data: input.update,
      });

      // Single-ledger money-in / money-out, transactional with the state update.
      if (
        updated.status === SubscriptionStatus.expired ||
        updated.status === SubscriptionStatus.revoked
      ) {
        // Expiry / refund / revoke → bounded clawback of the unused
        // subscription portion. Cancel-while-active never reaches here: it
        // only flips willRenew (status stays active), so credits stay to the
        // period end. Idempotent per (subscription, periodStart).
        await forfeitSubscriptionPeriod(tx, { subscription: updated });
      } else if (
        isEntitledSubscriptionStatus(updated.status) &&
        updated.currentPeriodStart.getTime() >
          subscription.currentPeriodStart.getTime()
      ) {
        // A renewal advanced the period start → materialize the new period's
        // allotment. Guarding on "the start advanced" means a grace/billing-
        // retry transition that keeps the same period does not re-grant.
        const grantResult = await grantSubscriptionPeriod(tx, {
          subscription: updated,
          periodStart: updated.currentPeriodStart,
        });
        if (grantResult.kind === "granted") {
          return {
            kind: "applied" as const,
            subscription: grantResult.subscription,
          };
        }
      }

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
  provider: BillingProvider;
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
): UserSubscriptionDto => {
  const status = effectiveSubscriptionStatus(subscription);
  return {
    provider: subscription.provider,
    tier: requireSubscriptionTier(subscription.tier),
    period: subscription.period,
    status,
    productId: subscription.productId,
    currentPeriodEnd: subscription.currentPeriodEnd.toISOString(),
    willRenew: subscription.willRenew,
    isInTrial: status === SubscriptionStatus.trial,
  };
};
