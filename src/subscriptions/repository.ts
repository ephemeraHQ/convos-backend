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
  AccountNotLiveError,
  requireLiveAccount,
} from "@/accounts/require-live-account";
import {
  createEscrowCustody,
  CUSTODY_STATE_ESCROW,
  CUSTODY_STATE_EXHAUSTED,
  CUSTODY_STATE_HELD,
  CUSTODY_STATE_INVALIDATED,
  findCustodyCovering,
  invalidateCustody,
} from "@/subscriptions/custody";
import {
  forfeitSubscriptionPeriod,
  grantSubscriptionPeriod,
} from "@/subscriptions/grants";
import {
  LINEAGE_STATE_TOMBSTONED,
  lockLineage,
  resolveLineageId,
  resolveOrCreateLineageForKeys,
} from "@/subscriptions/lineage";
import { productMapping } from "@/subscriptions/product-mapping";
import {
  effectiveSubscriptionStatus,
  ENTITLED_SUBSCRIPTION_STATUSES,
  isEntitledSubscriptionStatus,
} from "@/subscriptions/status";
import { tierGrant } from "@/subscriptions/tier-config";
import {
  requireSubscriptionTier,
  SUBSCRIPTION_TIER_PLUS,
  type SubscriptionTier,
} from "@/subscriptions/tiers";
import {
  absorbTombstoneRotation,
  findTombstonedLineage,
  SubscriptionTombstonedError,
} from "@/subscriptions/tombstones";
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
/** Provider funding-event key for a verify input (see reclaim design). */
const verifyProviderPeriodKey = (input: VerifyInput): string =>
  input.provider === BillingProvider.apple
    ? `apple_txn_${input.transactionId}`
    : `play_order_${input.playOrderId}`;

export const upsertFromVerify = async (
  input: VerifyInput,
): Promise<VerifyResult> => {
  const externalId = providerSubscriptionId(input);
  // Resolve-or-create the lineage outside the money transaction (small,
  // retryable step); the transaction then begins with the lineage lock.
  const lineageId = await resolveOrCreateLineageForKeys({
    provider: input.provider,
    key:
      input.provider === BillingProvider.apple
        ? input.originalTransactionId
        : input.purchaseToken,
    linkedPurchaseToken:
      input.provider === BillingProvider.googlePlay
        ? input.linkedPurchaseToken
        : undefined,
  });
  try {
    return await prisma.$transaction(async (tx) => {
      // Lock order: lineage first (rule 1), then the caller's Account
      // (rule 2) — fences this verify against concurrent claims/deletions
      // and keeps the global order deadlock-free.
      const lineageCtx = await lockLineage(tx, lineageId);
      await requireLiveAccount(tx, input.accountId);

      const existing = await findExistingForVerify(tx, input);

      if (existing && existing.accountId !== input.accountId) {
        throw new SubscriptionAccountMismatchError(
          existing.accountId,
          input.accountId,
          externalId,
        );
      }

      // No live row: a tombstoned lineage (deleted account's still-active
      // store subscription) must not silently rebind to whichever account
      // verifies it next. A live row for the key always wins over the
      // tombstone state (the claim flow restores the lineage when it
      // re-homes the subscription), which is why this check is gated on
      // `!existing`.
      if (!existing) {
        const lineage = await tx.subscriptionLineage.findUnique({
          where: { id: lineageId },
        });
        if (lineage && lineage.state === LINEAGE_STATE_TOMBSTONED) {
          // Thrown inside the tx; the rotation absorption happens durably
          // in the catch below.
          throw new SubscriptionTombstonedError(
            input.provider,
            lineage.lineageKey,
            externalId,
            lineage.deletedAccountRef ?? "",
            lineage.id,
          );
        }
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
              data: { ...subscriptionUpdateData(input), lineageId },
            })
        : await tx.subscription.create({
            data: { ...subscriptionCreateData(input), lineageId },
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
      // Idempotent per (subscription, periodStart) per account and once per
      // provider funding event globally (lineage registry), so the initial
      // verify, a re-verify of the same period, an S2S DID_RENEW racing this
      // verify, or a post-transfer replay all resolve to one funded period.
      if (!isStaleVerify && isEntitledSubscriptionStatus(subscription.status)) {
        const grantResult = await grantSubscriptionPeriod(tx, {
          subscription,
          periodStart: subscription.currentPeriodStart,
          lineage: {
            ctx: lineageCtx,
            providerPeriodKey: verifyProviderPeriodKey(input),
            periodEnd: subscription.currentPeriodEnd,
          },
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
    if (err instanceof SubscriptionTombstonedError) {
      // Play token rotation onto a tombstoned lineage: record the presented
      // token as an alias so future lookups need no chain-walk. Done here,
      // outside the rolled-back transaction, so the absorption survives the
      // throw. Apple keys never rotate (matchedKey === presentedKey), so
      // this is Play-only in practice.
      if (err.matchedKey !== err.presentedKey) {
        await absorbTombstoneRotation(prisma, {
          token: err.presentedKey,
          lineageId: err.lineageId,
        });
      }
      throw err;
    }
    // Route the P2002 by WHICH unique index fired:
    //   - Subscription provider-unique → the documented cold-start race (two
    //     concurrent creates of the same provider sub). Benign idempotent
    //     replay: re-read the committed row.
    //   - BillingReceipt idempotencyKey → two concurrent /verify calls for the
    //     same transaction raced past the `existingReceipt` pre-check above and
    //     both reached `billingReceipt.create`. The loser must ALSO resolve
    //     idempotently (re-read → receiptCreated:false), NOT 500. The pre-check
    //     handles the sequential dup; this handles the concurrent dup.
    //   - CreditLedger (accountId, idempotencyKey) → a grant conflict. MUST
    //     rethrow: swallowing it would silently drop the just-created
    //     BillingReceipt and falsely report receiptCreated:false. With the
    //     UserCredits lock in grantSubscriptionPeriod this should not happen;
    //     rethrow is defense-in-depth.
    //   - Anything else → rethrow.
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002" &&
      (isSubscriptionProviderUniqueConflict(err) ||
        isBillingReceiptIdempotencyConflict(err))
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

// The four `@@unique([provider, …])` indexes on Subscription. With the Postgres
// driver, Prisma's `err.meta.target` is the array of conflicting FIELD names
// (e.g. ["provider", "originalTransactionId"]) — NOT the index name. We match on
// the second field of each provider-unique tuple (the first is always
// "provider"). Some adapters instead surface the index NAME as a string, so we
// also accept those for forward-compat.
const SUBSCRIPTION_PROVIDER_UNIQUE_FIELDS = new Set([
  "originalTransactionId",
  "appAccountToken",
  "purchaseToken",
  "obfuscatedAccountId",
]);
const SUBSCRIPTION_PROVIDER_UNIQUE_INDEX_NAMES = new Set([
  "subscription_apple_otx_unique",
  "subscription_apple_aat_unique",
  "subscription_play_token_unique",
  "subscription_play_oid_unique",
]);

const isSubscriptionProviderUniqueConflict = (
  err: Prisma.PrismaClientKnownRequestError,
): boolean => {
  if (err.meta?.modelName && err.meta.modelName !== "Subscription") {
    return false;
  }
  const target = err.meta?.target;
  const tokens =
    typeof target === "string"
      ? [target]
      : Array.isArray(target)
        ? target.map(String)
        : [];
  return tokens.some(
    (t) =>
      SUBSCRIPTION_PROVIDER_UNIQUE_FIELDS.has(t) ||
      SUBSCRIPTION_PROVIDER_UNIQUE_INDEX_NAMES.has(t),
  );
};

// The BillingReceipt-idempotencyKey conflict (a concurrent duplicate /verify
// losing the receipt-create race). BillingReceipt also has a separate
// `externalNotificationId @unique`, so `modelName === "BillingReceipt"` ALONE is
// ambiguous — we additionally require the conflicting target to be the
// idempotencyKey column (or its index name for forward-compat). CreditLedger's
// conflict is ["accountId", "idempotencyKey"] under modelName "CreditLedger", so
// the modelName gate keeps it out and it still rethrows.
const isBillingReceiptIdempotencyConflict = (
  err: Prisma.PrismaClientKnownRequestError,
): boolean => {
  const modelName = err.meta?.modelName;
  if (modelName !== undefined && modelName !== "BillingReceipt") return false;
  const target = err.meta?.target;
  const tokens =
    typeof target === "string"
      ? [target]
      : Array.isArray(target)
        ? target.map(String)
        : [];
  return tokens.some(
    (t) => t === "idempotencyKey" || t === "BillingReceipt_idempotencyKey_key",
  );
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
  /** Rotation predecessor from the refreshed Play purchase, when present.
   *  Used by the deletion-tombstone probe so a rotation onto a tombstoned
   *  token is absorbed rather than escaping the tombstone. */
  linkedPurchaseToken?: string | null;
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
  | { kind: "unknown_subscription" }
  /** The provider key belongs to a deleted account: acknowledged, counted
   *  no-op. No state was touched. */
  | { kind: "tombstoned" };

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
/** Provider funding-event key for a notification input. */
const notificationProviderPeriodKey = (
  input: ApplyNotificationInput,
): string =>
  input.provider === BillingProvider.apple
    ? `apple_txn_${input.transactionId}`
    : `play_order_${input.playOrderId}`;

/** Sentinel accountId on escrow-funded registry rows (no live owner). */
const ESCROW_REGISTRY_ACCOUNT_ID = "00000000-0000-0000-0000-000000000000";

const notificationTombstoneProbe = async (
  input: ApplyNotificationInput,
): Promise<ApplyNotificationResult | null> => {
  const lineage = await findTombstonedLineage(
    prisma,
    input.provider,
    input.provider === BillingProvider.apple
      ? [input.originalTransactionId]
      : [input.purchaseToken, input.linkedPurchaseToken],
  );
  if (!lineage) return null;
  const presentedKey =
    input.provider === BillingProvider.apple
      ? input.originalTransactionId
      : input.purchaseToken;
  if (lineage.lineageKey !== presentedKey) {
    // Play rotation onto a tombstoned lineage: absorb the new token so
    // future notifications resolve without chain-walking.
    await absorbTombstoneRotation(prisma, {
      token: presentedKey,
      lineageId: lineage.id,
    });
  }

  // Renewal while tombstoned: the funding event is recorded and the
  // allotment goes straight to escrow (there is no wallet to grant to), so
  // a later restoration can release the value. Requires the notification to
  // carry the tier/period/window fields (Apple SUBSCRIBED/DID_RENEW and the
  // Play renewal mappings do); events without them stay pure no-ops.
  const { update } = input;
  if (
    update.tier &&
    update.productId &&
    update.currentPeriodStart &&
    update.currentPeriodEnd &&
    update.status &&
    isEntitledSubscriptionStatus(update.status)
  ) {
    const period = periodForProduct(update.productId);
    if (period) {
      const credits = tierGrant(update.tier, period).perPeriod;
      const periodStart = update.currentPeriodStart;
      const periodEnd = update.currentPeriodEnd;
      if (credits > 0) {
        await prisma.$transaction(async (tx) => {
          const ctx = await lockLineage(tx, lineage.id);
          const providerPeriodKey = notificationProviderPeriodKey(input);
          const registryHit = await tx.lineagePeriodGrant.findUnique({
            where: {
              lineageId_providerPeriodKey: {
                lineageId: ctx.lineageId,
                providerPeriodKey,
              },
            },
          });
          const newerFunded = await tx.lineagePeriodCustody.findFirst({
            where: {
              lineageId: ctx.lineageId,
              periodStart: { gte: periodStart },
            },
            select: { id: true },
          });
          if (registryHit || newerFunded) return;
          await tx.lineagePeriodGrant.create({
            data: {
              lineageId: ctx.lineageId,
              providerPeriodKey,
              accountId: ESCROW_REGISTRY_ACCOUNT_ID,
              ledgerKey: `sub_escrow_fund_${ctx.lineageId}`,
            },
          });
          await createEscrowCustody(tx, ctx, {
            providerPeriodKey,
            credits: BigInt(credits),
            periodStart,
            periodEnd,
          });
        });
      }
    }
  }

  return { kind: "tombstoned" };
};

/** Billing period for a productId, or null when unmapped. */
const periodForProduct = (productId: string): SubscriptionPeriod | null => {
  try {
    return productMapping(productId).period;
  } catch {
    return null;
  }
};

export const applyNotification = async (
  input: ApplyNotificationInput,
): Promise<ApplyNotificationResult> => {
  const subscription = await notificationLookup(input);
  if (!subscription) {
    // Unknown key: distinguish "verify hasn't created the row yet" from
    // "the row was deleted with its account" — the latter is a counted
    // no-op, never a recreate.
    const tombstoned = await notificationTombstoneProbe(input);
    if (tombstoned) return tombstoned;
    return { kind: "unknown_subscription" };
  }

  const receiptShape = notificationReceiptShape(input);

  // Resolve-or-create the lineage outside the money transaction.
  const lineageId =
    subscription.lineageId ??
    (await resolveOrCreateLineageForKeys({
      provider: input.provider,
      key:
        input.provider === BillingProvider.apple
          ? input.originalTransactionId
          : input.purchaseToken,
      linkedPurchaseToken:
        input.provider === BillingProvider.googlePlay
          ? input.linkedPurchaseToken
          : undefined,
    }));

  try {
    return await prisma.$transaction(async (tx) => {
      // Lock order: lineage first (rule 1), then the owning Account
      // (rule 2). A teardown holding the locks makes this throw
      // AccountNotLiveError, converged below to a tombstone probe — and a
      // notification already past these locks blocks the teardown until it
      // commits, so neither side can deadlock.
      const lineageCtx = await lockLineage(tx, lineageId);
      await requireLiveAccount(tx, subscription.accountId);

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

      // STALENESS GUARD (mirrors verify's `isStaleVerify`, repository.ts ~388):
      // a valid but OUT-OF-ORDER notification — e.g. an EXPIRED/REVOKE for a
      // period a later renewal already superseded — must not roll the
      // subscription's entitlement window/status backwards NOR forfeit the
      // now-active period. Skipping only the forfeit is insufficient: the stale
      // update would still write a terminal status over the renewed active row.
      // So we skip the ENTIRE state-apply (update + grant + forfeit) when the
      // notification's own period end predates the stored one. The receipt is
      // already recorded above, preserving idempotency/audit. The terminal
      // mapping cases now carry `currentPeriodEnd` (from the JWS transaction's
      // expiresDate / the refreshed Play purchase) precisely so this guard has a
      // period to compare; updates that omit it (no period drift possible) fall
      // through and apply as before.
      if (
        input.update.currentPeriodEnd !== undefined &&
        input.update.currentPeriodEnd.getTime() <
          subscription.currentPeriodEnd.getTime()
      ) {
        return { kind: "applied" as const, subscription };
      }

      const updated = await tx.subscription.update({
        where: { id: subscription.id },
        data: { ...input.update, lineageId },
      });

      // Single-ledger money-in / money-out, transactional with the state update.
      if (
        updated.status === SubscriptionStatus.expired ||
        updated.status === SubscriptionStatus.revoked
      ) {
        // Expiry / refund / revoke → bounded clawback of the unused
        // subscription portion from the CURRENT custody holder (custody
        // works post-transfer, where account-scoped sub_grant discovery
        // would find nothing). When the holder is still the original
        // grantee the debit keeps the legacy sub_forfeit shape (idempotent
        // per (sub, period)); custody is invalidated either way so no later
        // move can touch the period again, and an already-settled custody
        // row (invalidated/exhausted) means a duplicate event claws
        // nothing. Periods funded before the lineage tables fall back to
        // the legacy per-subscription forfeit alone.
        // Cancel-while-active never reaches here: it only flips willRenew
        // (status stays active), so credits stay to the period end. Stale
        // out-of-order terminal events were already short-circuited by the
        // staleness guard above.
        const custody = await findCustodyCovering(
          tx,
          lineageCtx,
          updated.currentPeriodStart,
          [
            CUSTODY_STATE_HELD,
            CUSTODY_STATE_ESCROW,
            CUSTODY_STATE_INVALIDATED,
            CUSTODY_STATE_EXHAUSTED,
          ],
        );
        if (!custody) {
          await forfeitSubscriptionPeriod(tx, { subscription: updated });
        } else if (custody.state === CUSTODY_STATE_HELD) {
          if (custody.ownerAccountId === updated.accountId) {
            await forfeitSubscriptionPeriod(tx, { subscription: updated });
            await tx.lineagePeriodCustody.update({
              where: { id: custody.id },
              data: { remainderCap: 0n, state: CUSTODY_STATE_INVALIDATED },
            });
          } else {
            await invalidateCustody(tx, lineageCtx, {
              custody,
              journalId: custody.id,
            });
          }
        } else if (custody.state === CUSTODY_STATE_ESCROW) {
          // The value already left a wallet at deletion time; nothing
          // further moves.
          await tx.lineagePeriodCustody.update({
            where: { id: custody.id },
            data: { remainderCap: 0n, state: CUSTODY_STATE_INVALIDATED },
          });
        }
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
          lineage: {
            ctx: lineageCtx,
            providerPeriodKey: notificationProviderPeriodKey(input),
            periodEnd: updated.currentPeriodEnd,
          },
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
    if (err instanceof AccountNotLiveError) {
      // The owning account was deleted between the pre-tx lookup and the
      // Account lock. Same convergence as delete-then-notify.
      const tombstoned = await notificationTombstoneProbe(input);
      if (tombstoned) return tombstoned;
      return { kind: "unknown_subscription" };
    }
    if (err instanceof Prisma.PrismaClientKnownRequestError) {
      if (err.code === "P2002") {
        const current = await prisma.subscription.findUnique({
          where: { id: subscription.id },
        });
        if (current) {
          return { kind: "replayed", subscription: current };
        }
      }
      // Deletion raced this notification: the row (captured by the pre-tx
      // lookup) was torn down mid-flight, so the receipt insert hits the
      // Subscription FK (P2003) or the update finds no row (P2025). Converge
      // to the same outcome as delete-then-notify: a tombstoned (or unknown)
      // no-op, not a 500-and-retry.
      if (err.code === "P2003" || err.code === "P2025") {
        const current = await prisma.subscription.findUnique({
          where: { id: subscription.id },
        });
        if (!current) {
          const tombstoned = await notificationTombstoneProbe(input);
          if (tombstoned) return tombstoned;
          return { kind: "unknown_subscription" };
        }
      }
    }
    throw err;
  }
};

/**
 * Play voided-purchase compensation: claw the conservative remainder back
 * from whoever currently holds the period's custody (original owner, claim
 * transferee, or deletion escrow), and terminate the subscription row when
 * one still exists. Returns the compensated amount, or null when the token
 * resolves to nothing we track.
 */
export const compensateVoidedPurchase = async (
  purchaseToken: string,
): Promise<bigint | null> => {
  const lineageId = await resolveLineageId(prisma, BillingProvider.googlePlay, [
    purchaseToken,
  ]);
  if (!lineageId) return null;
  return prisma.$transaction(async (tx) => {
    const ctx = await lockLineage(tx, lineageId);
    const row = await tx.subscription.findFirst({ where: { lineageId } });
    if (row) {
      await tx.subscription.update({
        where: { id: row.id },
        data: {
          status: SubscriptionStatus.revoked,
          willRenew: false,
          cancelledAt: new Date(),
        },
      });
    }
    const custody = await findCustodyCovering(tx, ctx, new Date(), [
      CUSTODY_STATE_HELD,
      CUSTODY_STATE_ESCROW,
    ]);
    if (!custody) return 0n;
    return invalidateCustody(tx, ctx, { custody, journalId: custody.id });
  });
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
