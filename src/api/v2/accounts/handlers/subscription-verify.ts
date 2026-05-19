import {
  Environment,
  type JWSTransactionDecodedPayload,
} from "@apple/app-store-server-library";
import type { Request, Response } from "express";
import { z } from "zod";
import { verifyAndDecodeTransaction } from "@/subscriptions/jws-verifier";
import { productMapping } from "@/subscriptions/product-mapping";
import {
  AppleEnv,
  serializeUserSubscription,
  SubscriptionAccountMismatchError,
  SubscriptionStatus,
  upsertFromVerify,
  type VerifyInput,
} from "@/subscriptions/repository";
import { deriveSubscriptionStatusFromTransaction } from "@/subscriptions/status";
import { AppError } from "@/utils/errors";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Body intentionally takes ONLY the JWS. appAccountToken is extracted from
// the verified payload — the iOS client created it, passed it to StoreKit
// at purchase time, and Apple now echoes it in every receipt. Reading it
// from the JWS (vs trusting a separate request field) eliminates a session-
// stealing vector where a leaked JWS could be replayed under a different
// caller's account.
const bodySchema = z
  .object({
    jwsRepresentation: z.string().min(1),
  })
  .strict();

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

const buildVerifyInput = (
  accountId: string,
  appAccountToken: string,
  payload: JWSTransactionDecodedPayload,
  signedPayload: string,
): VerifyInput => {
  const productId = requireField(payload.productId, "productId");
  const { tier, period } = productMapping(productId);
  const status = deriveSubscriptionStatusFromTransaction(payload);

  return {
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

export async function subscriptionVerifyHandler(req: Request, res: Response) {
  const accountId = res.locals.accountId as string;

  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "Invalid request body",
      details: parsed.error.issues,
    });
    return;
  }

  let decoded: JWSTransactionDecodedPayload;
  try {
    decoded = await verifyAndDecodeTransaction(parsed.data.jwsRepresentation);
  } catch (err) {
    req.log.warn(
      { err: err instanceof Error ? err.message : err, accountId },
      "JWS transaction verification failed",
    );
    res.status(400).json({ error: "Invalid signed transaction" });
    return;
  }

  // appAccountToken comes from the verified JWS — iOS set it at purchase
  // time via StoreKit. Apple persists it; subsequent receipts echo it back.
  // Reject if Apple's payload doesn't carry one (would mean a misconfigured
  // client or a non-subscription product).
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
    return;
  }

  let input: VerifyInput;
  try {
    input = buildVerifyInput(
      accountId,
      appAccountToken,
      decoded,
      parsed.data.jwsRepresentation,
    );
  } catch (err) {
    if (err instanceof AppError) {
      res.status(err.statusCode).json({ error: err.message });
      return;
    }
    throw err;
  }

  // Strict ownership is enforced inside upsertFromVerify's transaction
  // (atomic with the upsert, so two concurrent verifies for the same
  // originalTransactionId from different accounts cannot both succeed). A
  // re-verify from a different signed-in account is rejected here to block a
  // class of session-stealing attacks where a leaked JWS could be replayed
  // under a different caller's account. Cross-account transfer (rare: user
  // signs up fresh on a new Convos account using the same Apple ID) becomes
  // a support operation, not a code path.
  try {
    const { subscription } = await upsertFromVerify(input);

    // Subscription credit allotments are derived from the Subscription row
    // + per-tier config at read time (see GET /v2/accounts/me/credits); we
    // intentionally do NOT write a grant() ledger row on verify. grant() is
    // reserved for additive credits — top-ups, NUX trial, manual ops, promo.
    res.status(200).json({
      subscription: serializeUserSubscription(subscription),
    });
    return;
  } catch (error) {
    if (error instanceof SubscriptionAccountMismatchError) {
      req.log.warn(
        {
          accountId,
          existingAccountId: error.existingAccountId,
          originalTransactionId: input.originalTransactionId,
        },
        "subscription.verify.account_mismatch",
      );
      res.status(409).json({
        error: "Subscription belongs to a different account. Contact support.",
        code: "subscription_account_mismatch",
      });
      return;
    }
    req.log.error(
      {
        error,
        stack: error instanceof Error ? error.stack : undefined,
        accountId,
        originalTransactionId: input.originalTransactionId,
      },
      "Failed to persist verified subscription",
    );
    res.status(500).json({ error: "Failed to verify subscription" });
    return;
  }
}
