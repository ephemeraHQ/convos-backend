import type { JWSTransactionDecodedPayload } from "@apple/app-store-server-library";
import { BillingProvider, SubscriptionStatus } from "@prisma/client";
import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import { AccountNotLiveError } from "@/accounts/require-live-account";
import { createApnsService } from "@/api/v2/notifications/apns-push.service";
import { createFcmService } from "@/api/v2/notifications/fcm-push.service";
import type { SubscriptionClaimPendingPayload } from "@/api/v2/notifications/types";
import { APPCHECK_HEADER } from "@/middleware/auth";
import { getSubscriptionStatuses } from "@/subscriptions/apple-server-api";
import {
  executeClaim,
  type ClaimSubscriptionSeed,
} from "@/subscriptions/claim";
import {
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
import {
  LineageUnresolvedError,
  resolveOrCreateAppleLineage,
  resolveOrCreateGoogleLineage,
} from "@/subscriptions/lineage";
import { productMapping } from "@/subscriptions/product-mapping";
import { serializeUserSubscription } from "@/subscriptions/repository";
import { deriveSubscriptionStatusFromTransaction } from "@/subscriptions/status";
import { getFirebaseApp } from "@/utils/firebase";
import logger from "@/utils/logger";
import { prisma } from "@/utils/prisma";
import { getRuntimeConfig } from "@/utils/runtimeConfig";

/**
 * POST /v2/accounts/me/subscription/claim.
 *
 * Explicit one-time ownership claim: tombstone restoration (deleted owner)
 * or live bearer-transfer (flagged; contest window). Proof requirements are
 * authoritative: the presented artifact must verify, the provider must say
 * the subscription is entitled NOW, and the artifact must be the
 * subscription's latest transaction. App Check attestation (limited-use
 * token, consumed on verification) is mandatory and fails closed — there is
 * no app_attest_enabled bypass on this route.
 */

// Strict discriminated union — no legacy platform-defaulting preprocess on
// this new route.
const appleClaimSchema = z
  .object({
    platform: z.literal("apple"),
    jwsRepresentation: z.string().min(1),
  })
  .strict();
const playClaimSchema = z
  .object({
    platform: z.literal("googlePlay"),
    purchaseToken: z.string().min(1),
    productId: z.string().min(1),
  })
  .strict();
const claimBodySchema = z.discriminatedUnion("platform", [
  appleClaimSchema,
  playClaimSchema,
]);

// ---------------------------------------------------------------------------
// App Check (claim-specific, non-bypassable, consume semantics)
// ---------------------------------------------------------------------------

type ClaimAppCheckVerifier = (token: string) => Promise<void>;

const defaultClaimAppCheckVerifier: ClaimAppCheckVerifier = async (token) => {
  const { getAppCheck } = await import("firebase-admin/app-check");
  const result = (await getAppCheck(getFirebaseApp()).verifyToken(token, {
    consume: true,
  })) as { alreadyConsumed?: boolean };
  if (result.alreadyConsumed) {
    throw new Error("App Check token already consumed");
  }
};

let claimAppCheckVerifier: ClaimAppCheckVerifier | null = null;

/** Test seam: inject a fake verifier; null restores the firebase default. */
export const __setClaimAppCheckVerifierForTests = (
  verifier: ClaimAppCheckVerifier | null,
): void => {
  claimAppCheckVerifier = verifier;
};

/**
 * Mandatory attestation, checked before any provider call. Single error
 * code for every failure mode (missing, invalid, replayed, attestation
 * disabled) — no oracle. Deliberately does NOT use the global
 * appCheckOnlyMiddleware: its app_attest_enabled=false bypass would leave
 * this route open; here the flag is read directly and a disabled
 * attestation config means the endpoint is OFF — even a valid token is
 * rejected, never waved through.
 */
export const claimAppCheckMiddleware = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const appAttestEnabled =
    (await getRuntimeConfig("app_attest_enabled", "true")) === "true";
  if (!appAttestEnabled) {
    req.log.warn({}, "subscription.claim.app_check_disabled_fail_closed");
    res
      .status(403)
      .json({ error: "App attestation required", code: "app_check_required" });
    return;
  }
  const token = req.header(APPCHECK_HEADER);
  if (!token) {
    res
      .status(403)
      .json({ error: "App attestation required", code: "app_check_required" });
    return;
  }
  try {
    const verifier = claimAppCheckVerifier ?? defaultClaimAppCheckVerifier;
    await verifier(token);
    next();
  } catch (error) {
    req.log.warn({ error }, "subscription.claim.app_check_rejected");
    res
      .status(403)
      .json({ error: "App attestation required", code: "app_check_required" });
    return;
  }
};

// ---------------------------------------------------------------------------
// Provider proof
// ---------------------------------------------------------------------------

/** Apple statuses that count as entitled-now: 1 = active, 4 = grace. */
const ENTITLED_APPLE_STATUSES = new Set([1, 4]);

type VerifiedProof = {
  lineageId: string;
  currentPeriodStart: Date;
  seed: ClaimSubscriptionSeed;
  proofMetadata: Record<string, string>;
};

type ProofRejection =
  | { status: 400 }
  | { status: 404 }
  | { status: 409; reason: "not_entitled" | "lineage_unresolved" };

const rejectionResponse = (res: Response, rejection: ProofRejection): void => {
  if (rejection.status === 400) {
    res
      .status(400)
      .json({ error: "Invalid claim proof", code: "invalid_claim_proof" });
    return;
  }
  if (rejection.status === 404) {
    res.status(404).json({
      error: "No subscription found for this purchase",
      code: "subscription_not_found",
    });
    return;
  }
  res.status(409).json({
    error: "Subscription cannot be claimed",
    code: "subscription_claim_rejected",
    reason: rejection.reason,
  });
};

const verifyAppleProof = async (
  req: Request,
  jwsRepresentation: string,
): Promise<VerifiedProof | ProofRejection> => {
  let decoded: JWSTransactionDecodedPayload;
  try {
    decoded = await verifyAndDecodeTransaction(jwsRepresentation);
  } catch (error) {
    req.log.warn({ error }, "subscription.claim.invalid_jws");
    return { status: 400 };
  }
  const otx = decoded.originalTransactionId;
  const transactionId = decoded.transactionId;
  const productId = decoded.productId;
  if (!otx || !transactionId || !productId || !decoded.expiresDate) {
    return { status: 400 };
  }

  // Mandatory authoritative lookup: entitled now + latest-transaction match
  // against Apple's own answer (matched by OTX + environment, never
  // lastTransactions[0]).
  let latest: JWSTransactionDecodedPayload | null = null;
  let entitledNow = false;
  try {
    const statuses = await getSubscriptionStatuses(otx);
    for (const group of statuses.data ?? []) {
      for (const item of group.lastTransactions ?? []) {
        if (item.originalTransactionId !== otx || !item.signedTransactionInfo) {
          continue;
        }
        const candidate = await verifyAndDecodeTransaction(
          item.signedTransactionInfo,
        );
        if (candidate.environment !== decoded.environment) continue;
        latest = candidate;
        entitledNow =
          item.status !== undefined && ENTITLED_APPLE_STATUSES.has(item.status);
      }
    }
  } catch (error) {
    req.log.warn({ error }, "subscription.claim.apple_status_lookup_failed");
    return { status: 400 };
  }
  if (!latest) return { status: 400 };
  if (!entitledNow) return { status: 409, reason: "not_entitled" };
  if (latest.transactionId !== transactionId) {
    // Only the subscription's newest artifact is ever usable.
    return { status: 400 };
  }

  const { tier, period } = productMapping(productId);
  const status = deriveSubscriptionStatusFromTransaction(decoded);
  const currentPeriodStart = new Date(decoded.purchaseDate ?? Date.now());
  let lineageId: string;
  try {
    lineageId = await resolveOrCreateAppleLineage(otx);
  } catch (error) {
    if (error instanceof LineageUnresolvedError) {
      return { status: 409, reason: "lineage_unresolved" };
    }
    throw error;
  }
  return {
    lineageId,
    currentPeriodStart,
    seed: {
      provider: BillingProvider.apple,
      productId,
      tier,
      period,
      status,
      originalTransactionId: otx,
      appAccountToken: decoded.appAccountToken ?? null,
      startedAt: new Date(decoded.originalPurchaseDate ?? Date.now()),
      currentPeriodStart,
      currentPeriodEnd: new Date(decoded.expiresDate),
      willRenew: true,
      isInTrial: status === SubscriptionStatus.trial,
      environment:
        decoded.environment === "Production" ? "production" : "sandbox",
    },
    proofMetadata: { transactionId, originalTransactionId: otx },
  };
};

const verifyPlayProof = async (
  req: Request,
  body: z.infer<typeof playClaimSchema>,
): Promise<VerifiedProof | ProofRejection> => {
  let purchase: SubscriptionPurchaseV2;
  try {
    purchase = await fetchSubscriptionPurchaseV2(body.purchaseToken);
  } catch (error) {
    // Unknown/dead token.
    req.log.warn({ error }, "subscription.claim.play_fetch_failed");
    return { status: 400 };
  }
  const fetchedProductId = extractProductId(purchase);
  if (fetchedProductId !== body.productId) return { status: 400 };
  const status = deriveStatusFromPurchase(purchase);
  const entitled =
    status === SubscriptionStatus.active ||
    status === SubscriptionStatus.grace ||
    status === SubscriptionStatus.trial;
  if (!entitled) return { status: 409, reason: "not_entitled" };

  const { tier, period } = productMapping(fetchedProductId);
  const window = extractPeriodWindow(purchase);
  let lineageId: string;
  try {
    lineageId = await resolveOrCreateGoogleLineage({
      token: body.purchaseToken,
      linkedPurchaseToken: purchase.linkedPurchaseToken,
      fetchChain: true,
    });
  } catch (error) {
    if (error instanceof LineageUnresolvedError) {
      return { status: 409, reason: "lineage_unresolved" };
    }
    throw error;
  }
  return {
    lineageId,
    currentPeriodStart: window.currentPeriodStart,
    seed: {
      provider: BillingProvider.googlePlay,
      productId: fetchedProductId,
      tier,
      period,
      status,
      purchaseToken: body.purchaseToken,
      linkedPurchaseToken: purchase.linkedPurchaseToken ?? null,
      obfuscatedAccountId: extractObfuscatedAccountId(purchase),
      startedAt: purchase.startTime
        ? new Date(purchase.startTime)
        : window.currentPeriodStart,
      currentPeriodStart: window.currentPeriodStart,
      currentPeriodEnd: window.currentPeriodEnd,
      willRenew:
        purchase.lineItems?.[0]?.autoRenewingPlan?.autoRenewEnabled !== false,
      isInTrial: status === SubscriptionStatus.trial,
    },
    proofMetadata: {
      purchaseToken: body.purchaseToken,
      orderId: purchase.latestOrderId ?? "",
    },
  };
};

// ---------------------------------------------------------------------------
// Pending-transfer push notification (contest window)
// ---------------------------------------------------------------------------

type PendingTransferNotifier = (args: {
  oldAccountId: string;
  contestEndsAt: Date;
  provider: "apple" | "googlePlay";
}) => Promise<void>;

/**
 * Send the contract's SubscriptionClaimPending push to every registered
 * device of the old account — the one notification channel we have, and the
 * structural bound on the bearer-theft residual: the legitimate owner learns
 * a transfer is pending while any authenticated act still vetoes it. Each
 * device send is individually caught; a push failure never fails the claim.
 */
const defaultPendingTransferNotifier: PendingTransferNotifier = async ({
  oldAccountId,
  contestEndsAt,
  provider,
}) => {
  const devices = await prisma.deviceRegistration.findMany({
    where: {
      accountId: oldAccountId,
      disabled: false,
      pushToken: { not: null },
    },
    select: {
      deviceId: true,
      pushToken: true,
      pushTokenType: true,
      apnsEnv: true,
    },
  });
  logger.warn(
    { deviceCount: devices.length, contestEndsAt: contestEndsAt.toISOString() },
    "subscription.claim.pending_transfer_push",
  );
  if (devices.length === 0) return;

  const apns = createApnsService();
  const fcm = createFcmService();
  await Promise.all(
    devices.map(async (device) => {
      const payload: SubscriptionClaimPendingPayload = {
        clientId: device.deviceId,
        notificationType: "SubscriptionClaimPending",
        notificationData: {
          contestEndsAt: contestEndsAt.toISOString(),
          provider,
        },
      };
      const adapted = { ...device, id: device.deviceId };
      try {
        const service = device.pushTokenType === "apns" ? apns : fcm;
        if (!service) {
          logger.warn(
            { deviceId: device.deviceId, pushTokenType: device.pushTokenType },
            "subscription.claim.pending_push_service_unavailable",
          );
          return;
        }
        const result = await service.sendPushNotification({
          device: adapted,
          notification: payload,
          isSilent: false,
        });
        if (!result.success) {
          logger.warn(
            { deviceId: device.deviceId, error: result.error },
            "subscription.claim.pending_push_send_failed",
          );
        }
      } catch (err) {
        logger.warn(
          { err, deviceId: device.deviceId },
          "subscription.claim.pending_push_send_error",
        );
      }
    }),
  );
};

let pendingTransferNotifier: PendingTransferNotifier | null = null;

/** Test seam: inject a notifier; null restores the default. */
export const __setPendingTransferNotifierForTests = (
  notifier: PendingTransferNotifier | null,
): void => {
  pendingTransferNotifier = notifier;
};

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function subscriptionClaimHandler(req: Request, res: Response) {
  const accountId = res.locals.accountId as string;

  const parsed = claimBodySchema.safeParse(req.body);
  if (!parsed.success) {
    req.log.warn(
      { issues: parsed.error.issues },
      "subscription.claim.invalid_body",
    );
    res
      .status(400)
      .json({ error: "Invalid claim proof", code: "invalid_claim_proof" });
    return;
  }

  try {
    const proof =
      parsed.data.platform === "apple"
        ? await verifyAppleProof(req, parsed.data.jwsRepresentation)
        : await verifyPlayProof(req, parsed.data);
    if ("status" in proof) {
      req.log.warn(
        { platform: parsed.data.platform, rejection: proof },
        "subscription.claim.rejected",
      );
      rejectionResponse(res, proof);
      return;
    }

    const result = await executeClaim({
      callerAccountId: accountId,
      lineageId: proof.lineageId,
      currentPeriodStart: proof.currentPeriodStart,
      subscriptionSeed: proof.seed,
      providerProof: proof.proofMetadata,
    });

    switch (result.kind) {
      case "restored":
      case "transferred":
      case "replayed": {
        req.log.info(
          { kind: result.kind, lineageId: proof.lineageId },
          "subscription.claim.granted",
        );
        res.status(200).json({
          subscription: serializeUserSubscription(result.subscription),
        });
        return;
      }
      case "pending": {
        const notifier =
          pendingTransferNotifier ?? defaultPendingTransferNotifier;
        try {
          await notifier({
            oldAccountId: result.oldAccountId,
            contestEndsAt: result.contestEndsAt,
            provider: parsed.data.platform,
          });
        } catch (error) {
          req.log.warn({ error }, "subscription.claim.pending_push_failed");
        }
        res.status(202).json({
          status: "pending",
          contestEndsAt: result.contestEndsAt.toISOString(),
        });
        return;
      }
      case "rejected": {
        req.log.warn(
          { reason: result.reason, lineageId: proof.lineageId },
          "subscription.claim.rejected",
        );
        res.status(409).json({
          error: "Subscription cannot be claimed",
          code: "subscription_claim_rejected",
          reason: result.reason,
        });
        return;
      }
      case "not_found": {
        rejectionResponse(res, { status: 404 });
        return;
      }
    }
  } catch (error) {
    if (error instanceof AccountNotLiveError) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    if (error instanceof LineageUnresolvedError) {
      res.status(409).json({
        error: "Subscription cannot be claimed",
        code: "subscription_claim_rejected",
        reason: "lineage_unresolved",
      });
      return;
    }
    req.log.error(
      { error, stack: error instanceof Error ? error.stack : undefined },
      "subscription.claim.failed",
    );
    res.status(500).json({ error: "Failed to claim subscription" });
    return;
  }
}
