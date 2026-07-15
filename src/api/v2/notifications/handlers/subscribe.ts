import type { Request, Response } from "express";
import { hexToUint8Array } from "uint8array-extras";
import { z } from "zod";
import {
  AccountNotLiveError,
  requireLiveAccount,
} from "@/accounts/require-live-account";
import { createNotificationClient } from "@/notifications/client";
import { verifyDeviceOwnership } from "@/utils/auth-guards";
import { deviceIdSchema } from "@/utils/device-id";
import { prisma } from "@/utils/prisma";

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
});

export type ISubscribeRequestBody = z.infer<typeof subscribeRequestSchema>;

const notificationClient = createNotificationClient();

export async function subscribe(
  req: Request<unknown, unknown, ISubscribeRequestBody>,
  res: Response,
) {
  try {
    const body = subscribeRequestSchema.parse(req.body);

    req.log.info(
      {
        accountId: res.locals.accountId,
        // Explicit boolean so Datadog can count legacy-JWT subscribes
        // without depending on whether the logger drops or renders null
        // for an undefined accountId field.
        hasAccountId: res.locals.accountId !== undefined,
        deviceId: body.deviceId,
        clientId: body.clientId,
        topicCount: body.topics.length,
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
        { deviceId: body.deviceId },
        "Device not found for subscribe",
      );
      res.status(404).json({ error: "Device not found" });
      return;
    }

    if (device.disabled) {
      req.log.warn({ deviceId: body.deviceId }, "Device is disabled");
      res.status(403).json({ error: "Device is disabled" });
      return;
    }

    // Convert HMAC keys to Uint8Array
    const subscriptions = body.topics.map((topic) => ({
      topic: topic.topic,
      isSilent: false,
      hmacKeys: topic.hmacKeys.map((key) => ({
        thirtyDayPeriodsSinceEpoch: key.thirtyDayPeriodsSinceEpoch,
        key: hexToUint8Array(key.key),
      })),
    }));

    // Register installation with notification server (only if pushToken exists)
    if (!device.pushToken) {
      req.log.info(
        {
          accountId: res.locals.accountId,
          deviceId: body.deviceId,
          clientId: body.clientId,
        },
        "Device has no push token yet - subscription will be activated once token is registered",
      );
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

        // Subscribe to topics
        await notificationClient.subscribeWithMetadata({
          installationId: body.clientId,
          subscriptions,
        });
      } catch (remoteErr) {
        // Compensate: best-effort delete installation to avoid orphaned state
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

    // Create or update client identifier record. accountId is sourced
    // from the JWT and is what the webhook delivery guard compares
    // against the joined DeviceRegistration.accountId before sending a
    // push. Older iOS builds that authenticate without SIWE produce a
    // JWT with no accountId; leave the field untouched in that case so
    // the migration backfill value (or a prior accountId from a SIWE
    // authentication on the same row) is not clobbered.
    const accountId = res.locals.accountId;
    try {
      // ClientIdentifier.accountId is a plain scalar (no FK to Account), so
      // this upsert must fence itself against a concurrent account deletion:
      // requireLiveAccount takes FOR KEY SHARE on the Account row inside the
      // same transaction, serializing against the deletion's FOR UPDATE. A
      // deleted account aborts here instead of attaching a stale row the
      // teardown sweep already passed.
      await prisma.$transaction(async (tx) => {
        if (accountId !== undefined) {
          await requireLiveAccount(tx, accountId);
        }
        await tx.clientIdentifier.upsert({
          where: { id: body.clientId },
          create: {
            id: body.clientId,
            deviceId: body.deviceId,
            accountId,
          },
          update: {
            deviceId: body.deviceId,
            ...(accountId !== undefined ? { accountId } : {}),
          },
        });
      });
    } catch (dbErr) {
      // Compensate: delete installation to maintain consistency (only if we created one)
      if (device.pushToken) {
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
        accountId: res.locals.accountId,
        deviceId: body.deviceId,
        clientId: body.clientId,
      },
      "Subscribed successfully",
    );
    res.status(200).send();
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
    if (error instanceof AccountNotLiveError) {
      // Account deleted between requireAccount and the fenced write. Generic
      // 401 like every other fail-closed route (the compensation above
      // already removed the just-registered installation).
      req.log.warn(
        { deviceId: res.locals.deviceId },
        "notifications.subscribe.account_not_live",
      );
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    req.log.error({ error }, "Failed to subscribe to topics");
    res.status(500).json({ error: "Failed to subscribe to topics" });
    return;
  }
}
