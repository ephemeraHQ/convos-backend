import {
  type JWSTransactionDecodedPayload,
  type ResponseBodyV2DecodedPayload,
} from "@apple/app-store-server-library";
import type { Request, Response } from "express";
import { z } from "zod";
import {
  verifyAndDecodeNotification,
  verifyAndDecodeTransaction,
} from "@/subscriptions/jws-verifier";
import { mapNotificationToUpdate } from "@/subscriptions/notification-mapping";
import { applyNotification, BillingProvider } from "@/subscriptions/repository";

const bodySchema = z
  .object({
    signedPayload: z.string().min(1),
  })
  .passthrough();

/**
 * App Store Server Notifications v2 endpoint. No auth — Apple authenticates
 * via the JWS signature, which we verify against AppleRootCA-G2/G3.
 *
 * Response semantics: 200 acknowledges the notification (Apple stops
 * retrying). We return 200 on every outcome except an invalid signature
 * (400), malformed payload (400), or an unexpected runtime error (500). Replay
 * (duplicate Apple notificationUUID) and unknown_subscription both ack 200 —
 * Apple has no need to retry; either the dupe was harmless or our verify
 * endpoint will eventually create the Subscription row.
 *
 * Observability — stable log events (log-explorer / monitor contract; see
 * docs/observability/subscription-notifications.md before renaming):
 *   - `subscription.ssn.received`: a signature-verified delivery arrived
 *     (fires after the outer JWS verifies, so unverifiable garbage on this
 *     unauthenticated endpoint doesn't count as feed traffic).
 *   - `subscription.ssn.applied`: a state change was applied (or replayed).
 *   - `subscription.ssn.dropped`: the delivery produced no state change;
 *     carries `reason` plus every identifier available at the drop point
 *     (notificationType/notificationSubtype/notificationUUID/
 *     originalTransactionId). reason=unknown_subscription drops are also
 *     persisted as BillingReceipt rows with subscriptionId NULL.
 * The 500 path is neither applied nor dropped — Apple retries it.
 */
export async function appleSsnHandler(req: Request, res: Response) {
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    req.log.warn({ reason: "invalid_body" }, "subscription.ssn.dropped");
    res.status(400).json({ error: "Invalid request body" });
    return;
  }

  const signedPayload = parsed.data.signedPayload;

  let notification: ResponseBodyV2DecodedPayload;
  try {
    notification = await verifyAndDecodeNotification(signedPayload);
  } catch (err) {
    // VerificationException from @apple/app-store-server-library carries
    // its actionable info on `.status` (enum 0-7), not `.message`
    // (`super()` is called with no args, so message is "").
    // Log both so ops can tell INVALID_APP_IDENTIFIER (3) /
    // INVALID_ENVIRONMENT (4) / INVALID_CERTIFICATE (6) apart from a
    // signature failure (1).
    req.log.warn(
      {
        reason: "invalid_notification_signature",
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
      "subscription.ssn.dropped",
    );
    res.status(400).json({ error: "Invalid signed notification" });
    return;
  }

  // Feed-liveness marker: one per signature-verified delivery, regardless of
  // what processing decides below (received = applied + dropped-after-verify).
  req.log.info(
    {
      notificationType: notification.notificationType,
      notificationSubtype: notification.subtype,
      notificationUUID: notification.notificationUUID,
      environment: notification.data?.environment,
    },
    "subscription.ssn.received",
  );

  const notificationUUID = notification.notificationUUID;
  if (!notificationUUID) {
    req.log.warn(
      {
        reason: "missing_notification_uuid",
        notificationType: notification.notificationType,
        notificationSubtype: notification.subtype,
      },
      "subscription.ssn.dropped",
    );
    res.status(400).json({ error: "Malformed notification payload" });
    return;
  }

  const signedTransactionInfo = notification.data?.signedTransactionInfo;
  if (!signedTransactionInfo) {
    // Summary / externalPurchaseToken / appData branches carry no transaction.
    // We don't act on those today; ack so Apple stops retrying.
    req.log.info(
      {
        reason: "no_transaction",
        notificationType: notification.notificationType,
        notificationSubtype: notification.subtype,
        notificationUUID,
      },
      "subscription.ssn.dropped",
    );
    res.status(200).json({ ok: true, skipped: "no_transaction" });
    return;
  }

  let transaction: JWSTransactionDecodedPayload;
  try {
    transaction = await verifyAndDecodeTransaction(signedTransactionInfo);
  } catch (err) {
    req.log.warn(
      {
        reason: "invalid_transaction_signature",
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
        notificationType: notification.notificationType,
        notificationSubtype: notification.subtype,
        notificationUUID,
      },
      "subscription.ssn.dropped",
    );
    res.status(400).json({ error: "Invalid signed transaction" });
    return;
  }

  const originalTransactionId = transaction.originalTransactionId;
  const transactionId = transaction.transactionId;
  if (!originalTransactionId || !transactionId) {
    req.log.warn(
      {
        reason: "missing_transaction_ids",
        notificationType: notification.notificationType,
        notificationSubtype: notification.subtype,
        notificationUUID,
        originalTransactionId,
        transactionId,
      },
      "subscription.ssn.dropped",
    );
    res.status(400).json({ error: "Malformed transaction payload" });
    return;
  }

  const update = mapNotificationToUpdate({
    notificationType: notification.notificationType,
    subtype: notification.subtype,
    transaction,
  });

  if (!update) {
    // TEST / CONSUMPTION_REQUEST / unknown types — no state change implied.
    req.log.info(
      {
        reason: "no_actionable_update",
        notificationType: notification.notificationType,
        notificationSubtype: notification.subtype,
        notificationUUID,
        originalTransactionId,
        transactionId,
      },
      "subscription.ssn.dropped",
    );
    res.status(200).json({ ok: true, applied: false });
    return;
  }

  try {
    const result = await applyNotification({
      provider: BillingProvider.apple,
      originalTransactionId,
      transactionId,
      notificationUUID,
      notificationType: notification.notificationType ?? "UNKNOWN",
      notificationSubtype: notification.subtype ?? null,
      signedPayload,
      update,
    });

    if (result.kind === "unknown_subscription") {
      // SUBSCRIBED before verify? verify hasn't run yet — drop and ack; the
      // client will hit /verify shortly and bootstrap the row from its own
      // JWS. A drop receipt (BillingReceipt, subscriptionId NULL) was
      // persisted by applyNotification so the delivery stays auditable —
      // this is the primary DB signal for "SSNs arriving for subs we don't
      // know" (orphaned/never-verified subscriptions).
      req.log.warn(
        {
          reason: "unknown_subscription",
          notificationType: notification.notificationType,
          notificationSubtype: notification.subtype,
          notificationUUID,
          originalTransactionId,
          transactionId,
          receiptRecorded: result.receiptRecorded,
        },
        "subscription.ssn.dropped",
      );
      res.status(200).json({ ok: true, applied: false });
      return;
    }

    if (result.kind === "tombstoned") {
      // The subscription belonged to a deleted account. Explicit, counted
      // no-op: ack so Apple stops retrying; never recreate account-linked
      // state.
      req.log.info(
        {
          originalTransactionId,
          notificationType: notification.notificationType,
          notificationUUID,
        },
        "subscription.ssn.tombstoned_noop",
      );
      res.status(200).json({ ok: true, applied: false });
      return;
    }

    // Single-ledger: `applyNotification` already wrote the money move for this
    // notification inside its own transaction. On DID_RENEW it advances
    // currentPeriodStart and writes a real `sub_grant` credit row for the new
    // period (via grantSubscriptionPeriod), idempotent on the per-period key; on
    // EXPIRED/REVOKE it writes the bounded `sub_forfeit` adjustment.
    // Nothing is derived at read time — GET /v2/accounts/me/credits just reads
    // the one wallet balance.
    req.log.info(
      {
        notificationType: notification.notificationType,
        notificationSubtype: notification.subtype,
        notificationUUID,
        originalTransactionId,
        transactionId,
        environment: notification.data?.environment,
        accountId: result.subscription.accountId,
        subscriptionStatus: result.subscription.status,
        replayed: result.kind === "replayed",
      },
      "subscription.ssn.applied",
    );
    res.status(200).json({ ok: true, applied: result.kind === "applied" });
    return;
  } catch (error) {
    req.log.error(
      {
        error,
        stack: error instanceof Error ? error.stack : undefined,
        originalTransactionId,
      },
      "Failed to apply Apple S2S notification",
    );
    // Apple retries on 5xx — return 500 so the notification re-fires once
    // we've shipped a fix.
    res.status(500).json({ error: "Failed to apply notification" });
    return;
  }
}
