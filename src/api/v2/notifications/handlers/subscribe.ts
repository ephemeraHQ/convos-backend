import type { Request, Response } from "express";
import { hexToUint8Array } from "uint8array-extras";
import { z } from "zod";
import { createNotificationClient } from "@/notifications/client";
import { hashApnsToken, hashTopicSet } from "@/notifications/hash";
import { verifyDeviceOwnership } from "@/utils/auth-guards";
import { deviceIdSchema } from "@/utils/device-id";
import { prisma } from "@/utils/prisma";

/**
 * Idempotency window for short-circuiting `/v2/notifications/subscribe` when
 * the in-flight request matches the last successful remote-apply on every
 * load-bearing field. 10 minutes balances "absorb repeat-loops + force
 * reconciles" against "legitimate topic-set changes are picked up promptly".
 *
 * Long enough to swallow a 3s-poll-loop join flood (Stack 1 fix backstop).
 * Short enough that joining new groups while paused and resuming inside the
 * window still produces a fresh apply when the topic hash changes. APNS
 * token and apnsEnv changes ALWAYS reapply regardless of the TTL (the at-
 * apply fields differ from current DeviceRegistration), so the dangerous
 * "deliver to wrong device" mode is impossible by construction.
 */
const IDEMPOTENCY_TTL_MS = 10 * 60 * 1000;

const subscribeRequestSchema = z.object({
  deviceId: deviceIdSchema,
  clientId: z.string().uuid(),
  topics: z
    .array(
      z.object({
        topic: z.string(),
        hmacKeys: z.array(
          z.object({
            thirtyDayPeriodsSinceEpoch: z.number(),
            key: z.string().regex(/^[0-9a-fA-F]+$/, "Invalid hex string"),
          }),
        ),
      }),
    )
    .min(1)
    .max(100),
  // Optional diagnostic fields (Stack 2 D6). iOS sends these to give backend
  // and Datadog enough context to explain WHY a subscribe happened. All
  // optional so older iOS builds keep working untouched.
  context: z.string().max(64).optional(),
  source: z.string().max(32).optional(),
  // Aggregate counts per topic kind: { welcome: 1, group: 42, inviteDM: 7 }.
  // Stored as JSON; not used for any logic decision, purely diagnostic.
  kindSummary: z.record(z.string(), z.number()).optional(),
  // Force bypasses the idempotency check (used by the debug-screen "Force
  // Reconcile" button). Acceptable because the request still passes JWT
  // auth + deviceOwnership.
  force: z.boolean().optional(),
});

export type ISubscribeRequestBody = z.infer<typeof subscribeRequestSchema>;

/**
 * Reason the XMTP notifications server call was skipped this round trip.
 * iOS reads this to decide whether to write its local hash debounce cache
 * (only when remoteApplied === true), so a "200 but didn't actually do
 * anything" path doesn't silently break delivery (codex D16).
 */
type SkippedReason = "idempotent" | "no_push_token" | "disabled";

interface SubscribeResponse {
  ok: true;
  remoteApplied: boolean;
  snapshot: {
    hash: string;
    count: number;
    lastSubscribeAt: string;
  };
  skipped?: SkippedReason;
}

const notificationClient = createNotificationClient();

export async function subscribe(
  req: Request<unknown, unknown, ISubscribeRequestBody>,
  res: Response,
) {
  try {
    const body = subscribeRequestSchema.parse(req.body);

    // accountId is sourced from the JWT only, never from the request body.
    // Older iOS builds may not send it; that's fine, it ends up undefined.
    const accountId = res.locals.accountId;

    const topicHash = hashTopicSet(body.topics.map((t) => t.topic));

    req.log.info(
      {
        accountId,
        deviceId: body.deviceId,
        clientId: body.clientId,
        topicCount: body.topics.length,
        topicHash,
        context: body.context,
        source: body.source,
        force: body.force,
      },
      "Subscribing to topics",
    );

    // Verify the JWT token's deviceId matches the request's deviceId
    if (
      !verifyDeviceOwnership({
        req,
        res,
        jwtDeviceId: res.locals.deviceId,
        expectedDeviceId: body.deviceId,
      })
    ) {
      return;
    }

    // Verify device exists and is not disabled
    const device = await prisma.deviceRegistration.findUnique({
      where: { deviceId: body.deviceId },
    });

    if (!device) {
      req.log.warn(
        { accountId, deviceId: body.deviceId },
        "Device not found for subscribe",
      );
      res.status(404).json({ error: "Device not found" });
      return;
    }

    if (device.disabled) {
      // Bail to a 200 with skipped:"disabled" so iOS can render the reason
      // verbatim in the debug screen instead of treating it as a generic 4xx.
      // We do NOT block the request; the iOS cache will see remoteApplied=
      // false and re-attempt after the device is re-enabled.
      req.log.warn(
        { accountId, deviceId: body.deviceId },
        "Device is disabled — skipping subscribe",
      );
      const snapshotResponse = await readSnapshotForResponse(body.clientId);
      res.status(200).json({
        ok: true,
        remoteApplied: false,
        snapshot: snapshotResponse ?? {
          hash: topicHash,
          count: body.topics.length,
          lastSubscribeAt: new Date(0).toISOString(),
        },
        skipped: "disabled",
      } satisfies SubscribeResponse);
      return;
    }

    const currentTokenSha = hashApnsToken(device.pushToken);
    const now = new Date();

    // Idempotency check (D11): if the last successful remote-apply matches
    // every load-bearing field AND is within the TTL, skip the XMTP wire
    // call. APNS token and apnsEnv changes ALWAYS re-apply (the at-apply
    // fields are correctness state per D13 — backfilling from current
    // DeviceRegistration would silently let drift through).
    const existingSnapshot =
      await prisma.notificationSubscriptionSnapshot.findUnique({
        where: { clientId: body.clientId },
      });

    const idempotent =
      !body.force &&
      existingSnapshot !== null &&
      existingSnapshot.lastRemoteApplySucceeded &&
      existingSnapshot.topicHash === topicHash &&
      existingSnapshot.pushTokenSha256AtApply === currentTokenSha &&
      existingSnapshot.apnsEnvAtApply === device.apnsEnv &&
      now.getTime() - existingSnapshot.lastSubscribeAt.getTime() <
        IDEMPOTENCY_TTL_MS;

    if (idempotent) {
      req.log.info(
        {
          accountId,
          deviceId: body.deviceId,
          clientId: body.clientId,
          topicHash,
          skipped: "idempotent",
        },
        "Subscribe idempotent skip",
      );
      res.status(200).json({
        ok: true,
        remoteApplied: false,
        snapshot: {
          hash: existingSnapshot.topicHash,
          count: existingSnapshot.topicCount,
          lastSubscribeAt: existingSnapshot.lastSubscribeAt.toISOString(),
        },
        skipped: "idempotent",
      } satisfies SubscribeResponse);
      return;
    }

    // Convert HMAC keys to Uint8Array for the XMTP RPC.
    const subscriptions = body.topics.map((topic) => ({
      topic: topic.topic,
      isSilent: false,
      hmacKeys: topic.hmacKeys.map((key) => ({
        thirtyDayPeriodsSinceEpoch: key.thirtyDayPeriodsSinceEpoch,
        key: hexToUint8Array(key.key),
      })),
    }));

    // Register installation with XMTP notifications server (only when we
    // have a push token to deliver to). The no_push_token path returns
    // remoteApplied:false + skipped:"no_push_token" so iOS knows to retry
    // when the token arrives, instead of caching this 200 as success.
    let remoteApplied = false;
    let remoteApplyError: string | null = null;
    let skipped: SkippedReason | undefined;

    if (!device.pushToken) {
      req.log.info(
        { accountId, deviceId: body.deviceId, clientId: body.clientId },
        "Device has no push token yet — subscription will be activated once token is registered",
      );
      skipped = "no_push_token";
    } else {
      try {
        await notificationClient.registerInstallation({
          installationId: body.clientId,
          deliveryMechanism: {
            deliveryMechanismType: {
              case:
                device.pushTokenType === "apns"
                  ? "apnsDeviceToken"
                  : "firebaseDeviceToken",
              value: device.pushToken,
            },
          },
        });

        await notificationClient.subscribeWithMetadata({
          installationId: body.clientId,
          subscriptions,
        });
        remoteApplied = true;
      } catch (remoteErr) {
        remoteApplyError =
          remoteErr instanceof Error ? remoteErr.message : String(remoteErr);
        // Best-effort cleanup so we don't leave half-registered state.
        try {
          await notificationClient.deleteInstallation({
            installationId: body.clientId,
          });
        } catch (cleanupErr) {
          req.log.warn(
            { error: cleanupErr, installationId: body.clientId },
            "Failed to cleanup installation after subscription failure",
          );
        }
        throw remoteErr;
      }
    }

    // Upsert ClientIdentifier (id, deviceId, accountId) + snapshot in a
    // single transaction so the webhook accountId enforcement (T15) and
    // the idempotency check on the next call see consistent state.
    try {
      await prisma.$transaction(async (tx) => {
        await tx.clientIdentifier.upsert({
          where: { id: body.clientId },
          create: {
            id: body.clientId,
            deviceId: body.deviceId,
            accountId,
          },
          update: {
            deviceId: body.deviceId,
            accountId,
          },
        });

        await tx.notificationSubscriptionSnapshot.upsert({
          where: { clientId: body.clientId },
          create: {
            clientId: body.clientId,
            accountId,
            topicCount: body.topics.length,
            topicHash,
            kindSummary: body.kindSummary ?? undefined,
            lastContext: body.context,
            lastSubscribeAt: now,
            lastRemoteApplySucceeded: remoteApplied,
            lastRemoteApplyError: remoteApplyError,
            pushTokenSha256AtApply: currentTokenSha,
            apnsEnvAtApply: device.apnsEnv,
          },
          update: {
            accountId,
            topicCount: body.topics.length,
            topicHash,
            kindSummary: body.kindSummary ?? undefined,
            lastContext: body.context,
            lastSubscribeAt: now,
            lastRemoteApplySucceeded: remoteApplied,
            lastRemoteApplyError: remoteApplyError,
            pushTokenSha256AtApply: currentTokenSha,
            apnsEnvAtApply: device.apnsEnv,
          },
        });
      });
    } catch (dbErr) {
      // Compensate: undo the remote registration so XMTP doesn't keep
      // sending us pushes for a client we can't resolve.
      if (remoteApplied) {
        try {
          await notificationClient.deleteInstallation({
            installationId: body.clientId,
          });
        } catch (cleanupErr) {
          req.log.warn(
            { error: cleanupErr, installationId: body.clientId },
            "Failed to cleanup installation after DB failure",
          );
        }
      }
      throw dbErr;
    }

    req.log.info(
      {
        accountId,
        deviceId: body.deviceId,
        clientId: body.clientId,
        topicHash,
        remoteApplied,
        skipped,
      },
      "Subscribed successfully",
    );

    res.status(200).json({
      ok: true,
      remoteApplied,
      snapshot: {
        hash: topicHash,
        count: body.topics.length,
        lastSubscribeAt: now.toISOString(),
      },
      skipped,
    } satisfies SubscribeResponse);
    return;
  } catch (error) {
    if (error instanceof z.ZodError) {
      req.log.warn(
        { errors: error.errors },
        "Invalid request body for subscribe",
      );
      res.status(400).json({
        error: "Invalid request body",
        details: error.errors,
        hint: "topics must be an array of objects with { topic: string, hmacKeys: [{ thirtyDayPeriodsSinceEpoch: number, key: string }] }",
      });
      return;
    }
    req.log.error({ error }, "Failed to subscribe to topics");
    res.status(500).json({ error: "Failed to subscribe to topics" });
    return;
  }
}

async function readSnapshotForResponse(
  clientId: string,
): Promise<{ hash: string; count: number; lastSubscribeAt: string } | null> {
  const snapshot = await prisma.notificationSubscriptionSnapshot.findUnique({
    where: { clientId },
  });
  if (!snapshot) {
    return null;
  }
  return {
    hash: snapshot.topicHash,
    count: snapshot.topicCount,
    lastSubscribeAt: snapshot.lastSubscribeAt.toISOString(),
  };
}
