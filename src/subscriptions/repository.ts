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
  subGrantKey,
} from "@/subscriptions/grants";
import {
  effectiveSubscriptionStatus,
  ENTITLED_SUBSCRIPTION_STATUSES,
  isEntitledSubscription,
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
        // Exact VERIFY replay — but do NOT return before the grant check.
        // Subscribers who bought BEFORE the single-ledger deploy (#324) have a
        // Subscription + BillingReceipt but no `sub_grant` ledger row for the
        // period they are living in: their original verify predates the grant
        // write. This short-circuit used to return here unconditionally, so a
        // re-verify could never heal them — their wallet stayed unfunded (and
        // could sit negative) until the next renewal. Instead, make re-verify a
        // universal materializer: when the replayed subscription is entitled
        // and this verify is not stale, backfill the CURRENT period's grant if
        // its canonical `sub_grant` row is missing. `grantSubscriptionPeriod`
        // is idempotent per (sub, periodStart) and lock-serialized, so a
        // concurrent renewal/verify cannot double-grant; the pre-check below
        // only avoids taking the wallet lock on the common already-granted
        // replay. Replay semantics stay intact: receiptCreated stays false.
        //
        // The gate MUST be the TIME-AWARE `isEntitledSubscription` (the same
        // helper credits-get uses), not the stored-status check: a replay can
        // arrive long after the stored state went stale. Prod holds rows whose
        // stored status is still `active`/`grace` because the terminal EXPIRED
        // webhook was lost or delayed — their entitlement window has already
        // elapsed, and effectiveSubscriptionStatus resolves them to `expired`.
        // Backfilling a full period grant for such a LAPSED period would mint
        // credits that credits-get simultaneously frames as free-tier state.
        const replayed = existingReceipt.subscription;
        const isStaleReplay =
          input.currentPeriodEnd < replayed.currentPeriodEnd;
        if (!isStaleReplay && isEntitledSubscription(replayed)) {
          const currentPeriodGrant = await tx.creditLedger.findUnique({
            where: {
              accountId_idempotencyKey: {
                accountId: replayed.accountId,
                idempotencyKey: subGrantKey(
                  replayed.id,
                  replayed.currentPeriodStart,
                ),
              },
            },
          });
          if (!currentPeriodGrant) {
            await grantSubscriptionPeriod(tx, {
              subscription: replayed,
              periodStart: replayed.currentPeriodStart,
            });
          }
        }
        return {
          subscription: replayed,
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
      //
      // DELIBERATELY the stored-status gate here (unlike the time-aware gate
      // on the replay backfill above): this status was just derived from the
      // provider-verified input — deriveSubscriptionStatusFromTransaction
      // already maps a past expiresDate to `expired`, so stored ≈ effective at
      // this instant. The single-ledger contract is grant-then-forfeit: a
      // fresh verify grants the period and an expiry webhook claws back the
      // unused portion (pinned by account-credits.test.ts "past-ended active
      // subscription … wallet credits persist until forfeit"). Switching this
      // to the effective check would break that pinned semantic for nothing.
      if (!isStaleVerify && isEntitledSubscriptionStatus(subscription.status)) {
        // Renewal observed via verify: if the period start advanced past the
        // stored one, forfeit the ending period's unused allotment (no
        // carryover) before granting the new period. Guard strictly on
        // start-advance so a re-verify of the SAME period does not claw the
        // live period. The compare is ms-precise and relies on the provider
        // returning a STABLE per-period currentPeriodStart (Apple purchaseDate /
        // Play startTime are byte-identical across verify + S2S for one period);
        // a same-period re-verify therefore does not trip this guard. `existing`
        // is the pre-update row (ending period); the subscription.update above
        // holds the row lock that fences a racing S2S renewal onto the same
        // idempotent per-period forfeit key.
        if (
          existing !== null &&
          input.currentPeriodStart.getTime() >
            existing.currentPeriodStart.getTime()
        ) {
          await forfeitSubscriptionPeriod(tx, {
            subscription: existing,
            periodStart: existing.currentPeriodStart,
          });
        }
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
    // Route the P2002 by WHICH unique index fired:
    //   - Subscription provider-unique → the documented cold-start race (two
    //     concurrent creates of the same provider sub). Benign idempotent
    //     replay: re-read the committed row.
    //     - EXCEPT the Apple appAccountToken unique: the colliding row holds a
    //       DIFFERENT originalTransactionId, so the OTX re-read below finds
    //       nothing. That case gets its own (provider, appAccountToken)
    //       re-read further down instead of falling through to the rethrow.
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

      // reReadAfterRace resolves by OTX/purchaseToken only, so an
      // appAccountToken-unique conflict re-read null here and used to fall
      // through to the rethrow — a raw 500 to the user. That is the
      // account-recreation path: iOS generates the appAccountToken per
      // INSTALL, so it survives account deletion + recreation, and the
      // recreated account's fresh purchase (NEW originalTransactionId)
      // collides on the AAT unique with the OLD account's row. Resolve the
      // conflict by the index that actually fired: re-read by
      // (provider, appAccountToken) and surface the truthful outcome — the
      // standard account-mismatch 409 when the holder is another account, or
      // an idempotent replay when the caller already holds the row (mirrors
      // the same-account branch above). Mismatch semantics are unchanged;
      // only the crash becomes an honest 409.
      if (
        input.provider === BillingProvider.apple &&
        isAppleAppAccountTokenConflict(err)
      ) {
        const holder = await prisma.subscription.findUnique({
          where: {
            subscription_apple_aat_unique: {
              provider: BillingProvider.apple,
              appAccountToken: input.appAccountToken,
            },
          },
        });
        if (holder) {
          if (holder.accountId !== input.accountId) {
            throw new SubscriptionAccountMismatchError(
              holder.accountId,
              input.accountId,
              externalId,
            );
          }
          return { subscription: holder, receiptCreated: false };
        }
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

// The Apple (provider, appAccountToken) unique specifically — a SUBSET of the
// provider-unique set above, needed because reReadAfterRace cannot resolve this
// conflict: it re-reads by originalTransactionId, and the colliding row holds a
// DIFFERENT one (account recreation reuses the per-install AAT with a fresh
// purchase). Same target-shape tolerance as its siblings: the Postgres driver
// surfaces the conflicting FIELD names in `err.meta.target`; some adapters
// surface the index NAME instead.
const isAppleAppAccountTokenConflict = (
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
    (t) => t === "appAccountToken" || t === "subscription_apple_aat_unique",
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
        // period end. Idempotent per (subscription, periodStart). Stale
        // out-of-order terminal events were already short-circuited by the
        // staleness guard above, so this only fires for the current period
        // (natural expiry or a legitimate mid-period refund/revoke).
        await forfeitSubscriptionPeriod(tx, {
          subscription: updated,
          periodStart: updated.currentPeriodStart,
        });
      } else if (
        isEntitledSubscriptionStatus(updated.status) &&
        updated.currentPeriodStart.getTime() >
          subscription.currentPeriodStart.getTime()
      ) {
        // A renewal advanced the period start → forfeit the ending period's
        // unused allotment (no carryover), then materialize the new period.
        // `subscription` is the pre-update row, so its currentPeriodStart is
        // the ending period. Guarding on "the start advanced" means a grace/
        // billing-retry transition that keeps the same period neither forfeits
        // nor re-grants. Forfeit is idempotent per (sub, period) and fenced by
        // the preceding subscription.update row lock, so a racing verify for
        // the same advance no-ops on the forfeit key.
        await forfeitSubscriptionPeriod(tx, {
          subscription,
          periodStart: subscription.currentPeriodStart,
        });
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
