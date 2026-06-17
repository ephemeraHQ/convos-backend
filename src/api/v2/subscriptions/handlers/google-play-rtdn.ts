import type { Request, Response } from "express";
import { z } from "zod";
import { mapNotificationToUpdate } from "@/subscriptions/google-play/notification-mapping";
import {
  fetchSubscriptionPurchaseV2,
  type SubscriptionPurchaseV2,
} from "@/subscriptions/google-play/play-api";
import {
  PubsubAuthError,
  verifyPubsubPushAuth,
} from "@/subscriptions/google-play/verifier";
import { applyNotification, BillingProvider } from "@/subscriptions/repository";

const messageSchema = z.object({
  messageId: z.string().min(1),
  data: z.string().min(1),
  attributes: z.record(z.string()).optional(),
  publishTime: z.string().optional(),
});

const envelopeSchema = z
  .object({
    message: messageSchema,
    subscription: z.string().optional(),
  })
  .passthrough();

const subscriptionNotificationSchema = z
  .object({
    version: z.string().optional(),
    notificationType: z.number().int(),
    purchaseToken: z.string().min(1),
    subscriptionId: z.string().optional(),
  })
  .passthrough();

const voidedPurchaseNotificationSchema = z
  .object({
    purchaseToken: z.string().min(1),
    orderId: z.string().optional(),
    productType: z.number().int().optional(),
    refundType: z.number().int().optional(),
  })
  .passthrough();

const developerNotificationSchema = z
  .object({
    version: z.string().optional(),
    packageName: z.string().optional(),
    eventTimeMillis: z.union([z.string(), z.number()]).optional(),
    subscriptionNotification: subscriptionNotificationSchema.optional(),
    voidedPurchaseNotification: voidedPurchaseNotificationSchema.optional(),
    oneTimeProductNotification: z.unknown().optional(),
    testNotification: z.unknown().optional(),
  })
  .passthrough();

type DeveloperNotification = z.infer<typeof developerNotificationSchema>;

const decodeEnvelope = (
  data: string,
): { notification: DeveloperNotification; raw: string } => {
  const raw = Buffer.from(data, "base64").toString("utf-8");
  const parsed = developerNotificationSchema.parse(JSON.parse(raw));
  return { notification: parsed, raw };
};

/**
 * Google Play Real-time Developer Notifications endpoint. Pub/Sub push
 * delivers a base64-encoded DeveloperNotification under `message.data`. We
 * authenticate the request via the OIDC bearer token (signed by the
 * Pub/Sub-push service account configured on the topic subscription).
 *
 * Response semantics mirror the Apple S2S handler: 200 acks the message
 * (Pub/Sub stops retrying), 401 on bad auth (Pub/Sub retries with backoff),
 * 400 on malformed payload, 500 on persistence failure (Pub/Sub retries up
 * to 7 days — gives ops a window to ship a fix).
 */
export async function googlePlayRtdnHandler(req: Request, res: Response) {
  try {
    await verifyPubsubPushAuth(req.headers.authorization);
  } catch (err) {
    req.log.warn(
      {
        errName: err instanceof Error ? err.constructor.name : undefined,
        errMessage: err instanceof Error ? err.message : String(err),
      },
      "Pub/Sub RTDN auth failed",
    );
    const status = err instanceof PubsubAuthError ? 401 : 500;
    res.status(status).json({ error: "Unauthorized" });
    return;
  }

  const envParsed = envelopeSchema.safeParse(req.body);
  if (!envParsed.success) {
    res.status(400).json({ error: "Invalid Pub/Sub envelope" });
    return;
  }
  const { message } = envParsed.data;

  let envelope: { notification: DeveloperNotification; raw: string };
  try {
    envelope = decodeEnvelope(message.data);
  } catch (err) {
    req.log.warn(
      {
        messageId: message.messageId,
        errMessage: err instanceof Error ? err.message : String(err),
      },
      "RTDN payload failed to decode/validate",
    );
    res.status(400).json({ error: "Invalid RTDN payload" });
    return;
  }
  const { notification, raw } = envelope;

  // Test notification: Play Console "send a test notification" path. Just ack.
  if (notification.testNotification) {
    req.log.info({ messageId: message.messageId }, "play.rtdn.test_received");
    res.status(200).json({ ok: true, kind: "test" });
    return;
  }

  // Voided purchase / one-time product: out of scope today, ack so Pub/Sub
  // stops retrying.
  if (notification.voidedPurchaseNotification) {
    req.log.info(
      {
        messageId: message.messageId,
        purchaseToken:
          notification.voidedPurchaseNotification.purchaseToken.slice(0, 12),
      },
      "play.rtdn.voided_purchase — not implemented, acking",
    );
    res.status(200).json({ ok: true, kind: "voided_purchase_skipped" });
    return;
  }
  if (notification.oneTimeProductNotification) {
    res.status(200).json({ ok: true, kind: "one_time_skipped" });
    return;
  }

  const sub = notification.subscriptionNotification;
  if (!sub) {
    req.log.warn(
      { messageId: message.messageId },
      "RTDN has no subscriptionNotification — acking",
    );
    res.status(200).json({ ok: true, kind: "no_subscription_notification" });
    return;
  }

  // Cold-start: SUBSCRIPTION_PURCHASED arrives before /verify created the
  // row. The Android client will hit /verify moments later and bootstrap.
  // Apple's handler does the same with unknown_subscription.
  // We still ack so Pub/Sub stops retrying.
  let purchase: SubscriptionPurchaseV2;
  try {
    purchase = await fetchSubscriptionPurchaseV2(sub.purchaseToken);
  } catch (err) {
    req.log.error(
      {
        messageId: message.messageId,
        errMessage: err instanceof Error ? err.message : String(err),
      },
      "Failed to fetch SubscriptionPurchaseV2 from Play Developer API",
    );
    res.status(500).json({ error: "Play API fetch failed" });
    return;
  }

  let update;
  try {
    update = mapNotificationToUpdate({
      notificationType: sub.notificationType,
      purchase,
    });
  } catch (err) {
    req.log.warn(
      {
        messageId: message.messageId,
        notificationType: sub.notificationType,
        errMessage: err instanceof Error ? err.message : String(err),
      },
      "Failed to derive state update from RTDN",
    );
    res.status(400).json({ error: "Invalid RTDN state update" });
    return;
  }

  if (!update) {
    req.log.info(
      {
        messageId: message.messageId,
        notificationType: sub.notificationType,
      },
      "play.rtdn.no_actionable_state_change",
    );
    res.status(200).json({ ok: true, applied: false });
    return;
  }

  const playOrderId = purchase.latestOrderId ?? sub.purchaseToken;

  try {
    const result = await applyNotification({
      provider: BillingProvider.googlePlay,
      purchaseToken: sub.purchaseToken,
      playOrderId,
      messageId: message.messageId,
      notificationType: `PLAY_${sub.notificationType}`,
      notificationSubtype: null,
      signedPayload: raw,
      update,
    });

    if (result.kind === "unknown_subscription") {
      // SUBSCRIPTION_PURCHASED before verify, or a notification whose
      // purchaseToken our row hasn't been linked to yet. Ack; /verify will
      // create or refresh the row.
      req.log.info(
        {
          messageId: message.messageId,
          notificationType: sub.notificationType,
        },
        "play.rtdn.unknown_subscription — acking",
      );
      res.status(200).json({ ok: true, applied: false });
      return;
    }

    req.log.info(
      {
        messageId: message.messageId,
        notificationType: sub.notificationType,
        accountId: result.subscription.accountId,
        subscriptionStatus: result.subscription.status,
        replayed: result.kind === "replayed",
      },
      "play.rtdn.applied",
    );
    res.status(200).json({ ok: true, applied: result.kind === "applied" });
    return;
  } catch (err) {
    req.log.error(
      {
        messageId: message.messageId,
        errMessage: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      },
      "Failed to apply Google Play RTDN",
    );
    res.status(500).json({ error: "Failed to apply notification" });
    return;
  }
}
