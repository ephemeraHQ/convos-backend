import {
  Environment,
  type JWSTransactionDecodedPayload,
} from "@apple/app-store-server-library";
import type { Request, Response } from "express";
import { z } from "zod";
import { AccountNotLiveError } from "@/accounts/require-live-account";
import { evaluateClaimable } from "@/subscriptions/claim-eligibility";
import {
  acknowledgePurchase,
  fetchSubscriptionPurchaseV2,
  type SubscriptionPurchaseV2,
} from "@/subscriptions/google-play/play-api";
import {
  deriveStatusFromPurchase,
  extractObfuscatedAccountId,
  extractPeriodWindow,
  extractProductId,
} from "@/subscriptions/google-play/status";
import { verifyAndDecodeTransaction } from "@/subscriptions/jws-verifier";
import { quarantineLineageToken } from "@/subscriptions/lineage";
import { productMapping } from "@/subscriptions/product-mapping";
import {
  AppleEnv,
  BillingProvider,
  serializeUserSubscription,
  SubscriptionAccountMismatchError,
  SubscriptionStatus,
  upsertFromVerify,
  type AppleVerifyInput,
  type GooglePlayVerifyInput,
  type VerifyInput,
} from "@/subscriptions/repository";
import { deriveSubscriptionStatusFromTransaction } from "@/subscriptions/status";
import { SubscriptionTombstonedError } from "@/subscriptions/tombstones";
import { AppError } from "@/utils/errors";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Discriminated body. Apple branch takes ONLY the JWS — appAccountToken is
// extracted from the verified payload (iOS set it at StoreKit purchase time).
// Reading it from the JWS rather than trusting a body field eliminates a
// session-stealing vector where a leaked JWS could be replayed under a
// different caller's account. Same principle on the Google branch: the
// obfuscatedExternalAccountId comes from the server-fetched purchase, not
// the request body.
const appleBodySchema = z
  .object({
    platform: z.literal("apple"),
    jwsRepresentation: z.string().min(1),
  })
  .strict();

const playBodySchema = z
  .object({
    platform: z.literal("googlePlay"),
    purchaseToken: z.string().min(1),
    productId: z.string().min(1),
  })
  .strict();

const discriminatedBodySchema = z.discriminatedUnion("platform", [
  appleBodySchema,
  playBodySchema,
]);

// Backwards-compat: legacy iOS builds predate the `platform` discriminator
// (original PR-#215 contract) and POST a bare `{ jwsRepresentation }` with no
// `platform`. Default a missing `platform` to "apple" BEFORE the union parse so
// those bodies still route to the Apple arm. Only legacy Apple clients omit
// `platform`; Google clients always send `"googlePlay"`. The per-arm `.strict()`
// is preserved, so genuinely unknown keys are still rejected.
// Exported so contract tests can pin the client-facing request shape directly
// (see tests/subscriptions/verify-body-contract.test.ts). The append-only
// client-API rule (CLAUDE.md) means a legacy bare `{ jwsRepresentation }` must
// keep validating; that test guards against a future re-tightening.
export const verifyBodySchema = z.preprocess(
  (value) =>
    value &&
    typeof value === "object" &&
    (value as { platform?: unknown }).platform == null
      ? { ...(value as Record<string, unknown>), platform: "apple" }
      : value,
  discriminatedBodySchema,
);

const bodySchema = verifyBodySchema;

const requireField = <T>(value: T | undefined | null, field: string): T => {
  if (value === undefined || value === null) {
    throw new AppError(
      400,
      `Apple transaction is missing required field: ${field}`,
    );
  }
  return value;
};

const mapEnvironment = (raw: string | Environment | undefined): AppleEnv => {
  if (raw === Environment.PRODUCTION) return AppleEnv.production;
  // Sandbox + Xcode + LocalTesting all map to sandbox for storage purposes;
  // we only care about prod vs not-prod for routing.
  return AppleEnv.sandbox;
};

const buildAppleInput = (
  accountId: string,
  appAccountToken: string,
  payload: JWSTransactionDecodedPayload,
  signedPayload: string,
): AppleVerifyInput => {
  const productId = requireField(payload.productId, "productId");
  const { tier, period } = productMapping(productId);
  const status = deriveSubscriptionStatusFromTransaction(payload);

  return {
    provider: BillingProvider.apple,
    accountId,
    appAccountToken,
    productId,
    tier,
    period,
    status,
    originalTransactionId: requireField(
      payload.originalTransactionId,
      "originalTransactionId",
    ),
    transactionId: requireField(payload.transactionId, "transactionId"),
    startedAt: new Date(
      requireField(payload.originalPurchaseDate, "originalPurchaseDate"),
    ),
    currentPeriodStart: new Date(
      requireField(payload.purchaseDate, "purchaseDate"),
    ),
    currentPeriodEnd: new Date(
      requireField(payload.expiresDate, "expiresDate"),
    ),
    // On initial verify Apple's transaction doesn't carry renewalInfo. Default
    // to true (paying customer is presumed to want to renew); webhook updates
    // (DID_CHANGE_RENEWAL_STATUS) will correct this.
    willRenew: true,
    isInTrial: status === SubscriptionStatus.trial,
    environment: mapEnvironment(payload.environment),
    signedPayload,
  };
};

/**
 * Thrown when a Google purchase carries no `latestOrderId`. The order id is
 * the funding-event identity (reclaim v3 item 2): without it there is no
 * period key, and synthesizing one from the purchase token would let token
 * rotation masquerade as a new funding event. Fail closed: the event is
 * parked in LineageQuarantine for reconciliation and no grant is issued.
 */
export class MissingPlayOrderIdError extends Error {
  constructor(public readonly purchaseToken: string) {
    super("Google Play purchase has no latestOrderId");
    this.name = "MissingPlayOrderIdError";
    Object.setPrototypeOf(this, MissingPlayOrderIdError.prototype);
  }
}

const buildPlayInput = (
  accountId: string,
  body: z.infer<typeof playBodySchema>,
  purchase: SubscriptionPurchaseV2,
): GooglePlayVerifyInput => {
  const fetchedProductId = extractProductId(purchase);
  if (fetchedProductId !== body.productId) {
    // Reject mismatch so a malicious client can't claim a higher tier than
    // Play actually recorded.
    throw new AppError(
      400,
      `productId mismatch: client sent "${body.productId}", Google Play returned "${fetchedProductId}"`,
    );
  }
  const { tier, period } = productMapping(fetchedProductId);
  const obfuscatedAccountId = extractObfuscatedAccountId(purchase);
  if (!obfuscatedAccountId) {
    throw new AppError(
      400,
      "Google Play purchase has no obfuscatedExternalAccountId — Android client must set it via BillingFlowParams.Builder.setObfuscatedAccountId",
    );
  }
  const status = deriveStatusFromPurchase(purchase);
  const window = extractPeriodWindow(purchase);
  const startedAt = purchase.startTime
    ? new Date(purchase.startTime)
    : window.currentPeriodStart;
  if (!purchase.latestOrderId) {
    // No funding-event identity: fail closed (no key, no grant) — never
    // synthesize a key from the purchase token.
    throw new MissingPlayOrderIdError(body.purchaseToken);
  }
  const playOrderId = purchase.latestOrderId;
  const lineItem = purchase.lineItems?.[0];
  const willRenew = lineItem?.autoRenewingPlan?.autoRenewEnabled !== false;
  return {
    provider: BillingProvider.googlePlay,
    accountId,
    obfuscatedAccountId,
    productId: fetchedProductId,
    tier,
    period,
    status,
    purchaseToken: body.purchaseToken,
    linkedPurchaseToken: purchase.linkedPurchaseToken ?? null,
    playOrderId,
    startedAt,
    currentPeriodStart: window.currentPeriodStart,
    currentPeriodEnd: window.currentPeriodEnd,
    willRenew,
    isInTrial: status === SubscriptionStatus.trial,
    signedPayload: JSON.stringify(purchase),
  };
};

const handleAppleBranch = async (
  req: Request,
  res: Response,
  accountId: string,
  body: z.infer<typeof appleBodySchema>,
): Promise<VerifyInput | null> => {
  let decoded: JWSTransactionDecodedPayload;
  try {
    decoded = await verifyAndDecodeTransaction(body.jwsRepresentation);
  } catch (err) {
    req.log.warn(
      {
        accountId,
        errName: err instanceof Error ? err.constructor.name : undefined,
        errStatus: (err as { status?: number } | undefined)?.status,
        errMessage: err instanceof Error ? err.message : String(err),
        causeName:
          err instanceof Error && err.cause instanceof Error
            ? err.cause.constructor.name
            : undefined,
        causeMessage:
          err instanceof Error && err.cause instanceof Error
            ? err.cause.message
            : undefined,
      },
      "JWS transaction verification failed",
    );
    res.status(400).json({ error: "Invalid signed transaction" });
    return null;
  }

  req.log.info(
    {
      accountId,
      productId: decoded.productId,
      originalTransactionId: decoded.originalTransactionId,
      transactionId: decoded.transactionId,
      environment: decoded.environment,
      purchaseDate: decoded.purchaseDate,
      expiresDate: decoded.expiresDate,
      offerType: decoded.offerType,
    },
    "subscription.verify.jws_decoded",
  );

  const appAccountToken = decoded.appAccountToken;
  if (!appAccountToken || !uuidPattern.test(appAccountToken)) {
    req.log.warn(
      {
        accountId,
        hasAppAccountToken: appAccountToken !== undefined,
        transactionId: decoded.transactionId,
      },
      "subscription.verify.invalid_app_account_token",
    );
    res
      .status(400)
      .json({ error: "Apple transaction has no valid appAccountToken" });
    return null;
  }

  try {
    return buildAppleInput(
      accountId,
      appAccountToken,
      decoded,
      body.jwsRepresentation,
    );
  } catch (err) {
    if (err instanceof AppError) {
      res.status(err.statusCode).json({ error: err.message });
      return null;
    }
    throw err;
  }
};

const handlePlayBranch = async (
  req: Request,
  res: Response,
  accountId: string,
  body: z.infer<typeof playBodySchema>,
): Promise<{
  input: GooglePlayVerifyInput;
  purchase: SubscriptionPurchaseV2;
} | null> => {
  let purchase: SubscriptionPurchaseV2;
  try {
    purchase = await fetchSubscriptionPurchaseV2(body.purchaseToken);
  } catch (err) {
    const statusCode =
      err instanceof AppError
        ? err.statusCode
        : err &&
            typeof err === "object" &&
            "code" in err &&
            (err as { code?: number }).code === 404
          ? 400
          : 502;
    req.log.warn(
      {
        accountId,
        errMessage: err instanceof Error ? err.message : String(err),
      },
      "subscription.verify.play_api_fetch_failed",
    );
    res
      .status(statusCode)
      .json({ error: "Failed to fetch Google Play purchase" });
    return null;
  }

  req.log.info(
    {
      accountId,
      productId: purchase.lineItems?.[0]?.productId,
      subscriptionState: purchase.subscriptionState,
      acknowledgementState: purchase.acknowledgementState,
    },
    "subscription.verify.play_purchase_fetched",
  );

  try {
    const input = buildPlayInput(accountId, body, purchase);
    return { input, purchase };
  } catch (err) {
    if (err instanceof MissingPlayOrderIdError) {
      // Keyless funding event: park it for reconciliation and fail closed.
      // Retryable server-side condition, not a client fault.
      await quarantineLineageToken(
        BillingProvider.googlePlay,
        body.purchaseToken,
        "missing_latest_order_id",
        { source: "verify", accountId },
      );
      req.log.error(
        { accountId },
        "subscription.verify.play_missing_order_id_parked",
      );
      res
        .status(502)
        .json({ error: "Google Play purchase is missing its order identity" });
      return null;
    }
    if (err instanceof AppError) {
      res.status(err.statusCode).json({ error: err.message });
      return null;
    }
    throw err;
  }
};

const ackPlayIfPending = async (
  req: Request,
  productId: string,
  purchaseToken: string,
  purchase: SubscriptionPurchaseV2,
) => {
  if (purchase.acknowledgementState !== "ACKNOWLEDGEMENT_STATE_PENDING") {
    return;
  }
  try {
    await acknowledgePurchase(productId, purchaseToken);
  } catch (err) {
    // Don't fail the response — but log loudly: unacked purchases are voided
    // by Play after 3 days. Ops should catch this in logs and remediate.
    req.log.error(
      {
        productId,
        errMessage: err instanceof Error ? err.message : String(err),
      },
      "subscription.verify.play_ack_failed",
    );
  }
};

export async function subscriptionVerifyHandler(req: Request, res: Response) {
  const accountId = res.locals.accountId as string;

  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    const rawBody: unknown = req.body;
    req.log.warn(
      {
        accountId,
        bodyKeys:
          rawBody && typeof rawBody === "object"
            ? Object.keys(rawBody)
            : typeof rawBody,
        platform: (rawBody as { platform?: unknown } | undefined)?.platform,
        issues: parsed.error.issues,
      },
      "subscription.verify.invalid_body",
    );
    res.status(400).json({
      error: "Invalid request body",
      code: "invalid_request_body",
      details: parsed.error.issues,
    });
    return;
  }

  let input: VerifyInput;
  let playPurchase: SubscriptionPurchaseV2 | null = null;

  if (parsed.data.platform === "apple") {
    const built = await handleAppleBranch(req, res, accountId, parsed.data);
    if (!built) return;
    input = built;
  } else {
    const built = await handlePlayBranch(req, res, accountId, parsed.data);
    if (!built) return;
    input = built.input;
    playPurchase = built.purchase;
  }

  // Strict ownership is enforced inside upsertFromVerify's transaction
  // (atomic with the upsert). A re-verify from a different signed-in account
  // is rejected to block session-stealing where a leaked receipt/token could
  // be replayed under a different caller's account. Cross-account transfer
  // is a support operation, not a code path.
  try {
    const { subscription } = await upsertFromVerify(input);

    // Subscription credit allotments are derived from the Subscription row +
    // per-tier config at read time (see GET /v2/accounts/me/credits). We do
    // NOT write a grant() ledger row on verify. grant() is reserved for
    // additive credits — top-ups, NUX trial, manual ops, promo.
    req.log.info(
      {
        accountId,
        subscriptionId: subscription.id,
        provider: subscription.provider,
        productId: subscription.productId,
        tier: subscription.tier,
        period: subscription.period,
        status: subscription.status,
      },
      "subscription.verify.applied",
    );

    // Fire-and-forget Play acknowledgement so the response isn't blocked on
    // a second Google API round-trip.
    if (
      input.provider === BillingProvider.googlePlay &&
      playPurchase !== null
    ) {
      void ackPlayIfPending(
        req,
        input.productId,
        input.purchaseToken,
        playPurchase,
      );
    }

    res.status(200).json({
      subscription: serializeUserSubscription(subscription),
    });
    return;
  } catch (error) {
    if (error instanceof SubscriptionAccountMismatchError) {
      // `claimable` is additive and informative only: whether the claim
      // endpoint may succeed for this caller. The claim flow re-evaluates
      // authoritatively.
      const claimable = await evaluateClaimable({
        provider: input.provider,
        keys:
          input.provider === BillingProvider.apple
            ? [input.originalTransactionId]
            : [input.purchaseToken, input.linkedPurchaseToken],
      });
      req.log.warn(
        {
          accountId,
          existingAccountId: error.existingAccountId,
          providerSubscriptionId: error.providerSubscriptionId,
          claimable,
        },
        "subscription.verify.account_mismatch",
      );
      res.status(409).json({
        error: "Subscription belongs to a different account. Contact support.",
        code: "subscription_account_mismatch",
        claimable,
      });
      return;
    }
    if (error instanceof AccountNotLiveError) {
      // Caller's account was deleted between requireAccount and the verify
      // transaction. Generic 401 like every fail-closed route.
      req.log.warn({ accountId }, "subscription.verify.account_not_live");
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    if (error instanceof SubscriptionTombstonedError) {
      // Tombstoned provider key (deleted account's subscription): same 409
      // envelope as an ownership mismatch (append-only law - no new code),
      // claimable by definition. No entitlement, no row created.
      req.log.warn(
        {
          accountId,
          providerKey: error.matchedKey,
        },
        "subscription.verify.tombstoned",
      );
      res.status(409).json({
        error: "Subscription belongs to a different account. Contact support.",
        code: "subscription_account_mismatch",
        claimable: true,
      });
      return;
    }
    req.log.error(
      {
        error,
        stack: error instanceof Error ? error.stack : undefined,
        accountId,
        provider: input.provider,
      },
      "Failed to persist verified subscription",
    );
    res.status(500).json({ error: "Failed to verify subscription" });
    return;
  }
}
