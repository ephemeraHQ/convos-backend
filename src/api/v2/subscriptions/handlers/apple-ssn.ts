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
import { applyNotification } from "@/subscriptions/repository";

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
 */
export async function appleSsnHandler(req: Request, res: Response) {
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body" });
    return;
  }

  const signedPayload = parsed.data.signedPayload;

  let notification: ResponseBodyV2DecodedPayload;
  try {
    notification = await verifyAndDecodeNotification(signedPayload);
  } catch (err) {
    req.log.warn(
      { err: err instanceof Error ? err.message : err },
      "Apple S2S notification JWS verification failed",
    );
    res.status(400).json({ error: "Invalid signed notification" });
    return;
  }

  const notificationUUID = notification.notificationUUID;
  if (!notificationUUID) {
    req.log.warn(
      { notificationType: notification.notificationType },
      "Apple S2S notification missing notificationUUID",
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
        notificationType: notification.notificationType,
        notificationUUID: notification.notificationUUID,
      },
      "Apple S2S notification has no transaction — skipping",
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
        err: err instanceof Error ? err.message : err,
        notificationUUID: notification.notificationUUID,
      },
      "Apple S2S inner transaction JWS verification failed",
    );
    res.status(400).json({ error: "Invalid signed transaction" });
    return;
  }

  const originalTransactionId = transaction.originalTransactionId;
  const transactionId = transaction.transactionId;
  if (!originalTransactionId || !transactionId) {
    req.log.warn(
      { notificationUUID: notification.notificationUUID },
      "Apple S2S transaction missing originalTransactionId/transactionId",
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
    req.log.info(
      {
        notificationType: notification.notificationType,
        notificationUUID: notification.notificationUUID,
      },
      "Apple S2S notification has no actionable state change — acking",
    );
    res.status(200).json({ ok: true, applied: false });
    return;
  }

  try {
    const result = await applyNotification({
      originalTransactionId,
      transactionId,
      notificationUUID,
      notificationType: notification.notificationType ?? "UNKNOWN",
      notificationSubtype: notification.subtype ?? null,
      signedPayload,
      update,
    });

    if (result.kind === "unknown_subscription") {
      // SUBSCRIBED before verify? verify hasn't run yet — drop. The client
      // will hit /verify shortly and bootstrap the row from its own JWS.
      req.log.info(
        {
          originalTransactionId,
          notificationType: notification.notificationType,
        },
        "Apple S2S notification for unknown subscription — acking (verify will create)",
      );
      res.status(200).json({ ok: true, applied: false });
      return;
    }

    // No grant() write on DID_RENEW: subscription credit allotments are
    // derived from the Subscription row + per-tier config at read time (see
    // GET /v2/accounts/me/credits). Renewal updates currentPeriodStart, which
    // resets monthlyGrantUsed on the next read. grant() is reserved for
    // additive credits (top-ups, NUX trial, manual ops, promo).
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
