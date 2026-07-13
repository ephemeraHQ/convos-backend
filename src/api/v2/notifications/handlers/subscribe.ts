import type { Prisma } from "@prisma/client";
import type { Request, Response } from "express";
import { hexToUint8Array } from "uint8array-extras";
import { z } from "zod";
import { createNotificationClient } from "@/notifications/client";
import { verifyDeviceOwnership } from "@/utils/auth-guards";
import { deviceIdSchema } from "@/utils/device-id";
import { prisma } from "@/utils/prisma";

/**
 * The subset of a Prisma transaction client this module needs. Declared
 * structurally so the persistence logic can be unit-tested against a tiny
 * fake without standing up a real DB / `$transaction`.
 */
export interface SubscriptionIdentityTx {
  clientIdentifier: {
    upsert: (args: Prisma.ClientIdentifierUpsertArgs) => Promise<unknown>;
  };
  deviceRegistration: {
    updateMany: (
      args: Prisma.DeviceRegistrationUpdateManyArgs,
    ) => Promise<{ count: number }>;
  };
}

/**
 * Persist the subscribing client's identity in ONE transaction: upsert the
 * ClientIdentifier and (when authenticated) adopt the subscriber's account
 * onto the device.
 *
 * Why also stamp DeviceRegistration.accountId here:
 * The webhook delivery guard (isAccountIdMismatch) fails closed unless
 * ClientIdentifier.accountId === DeviceRegistration.accountId (both non-null).
 * `/v2/device/register` is AppCheck-only and never writes accountId, and the
 * `/auth/token` backfill no-ops when the device row doesn't exist yet, so a
 * device can sit with accountId = NULL indefinitely — silently dropping every
 * push. A subscribe carrying a verified accountId is a fresh authenticated
 * signal that *this* account currently owns the device, so we adopt it
 * ("current-subscriber-wins"): set device.accountId when it is NULL OR differs
 * from the subscriber.
 *
 * Safety: the guard fails closed, so a wrong/stale device.accountId can only
 * ever DROP a push, never deliver to the wrong account — no cross-account leak.
 * Shared-device thrash: two accounts actively subscribing on one physical
 * device will flip device.accountId back and forth; each flip self-corrects on
 * the next subscribe, and the loser merely misses pushes until it re-subscribes.
 * Only an accountId-bearing JWT mutates anything — legacy/non-SIWE builds
 * (accountId undefined) leave BOTH columns untouched so a backfilled or prior
 * SIWE value is never clobbered.
 *
 * Exported for unit testing.
 */
export async function persistSubscriptionIdentity(args: {
  tx: SubscriptionIdentityTx;
  clientId: string;
  deviceId: string;
  accountId: string | undefined;
}) {
  const { tx, clientId, deviceId, accountId } = args;

  await tx.clientIdentifier.upsert({
    where: { id: clientId },
    create: {
      id: clientId,
      deviceId,
      ...(accountId !== undefined ? { accountId } : {}),
    },
    update: {
      deviceId,
      ...(accountId !== undefined ? { accountId } : {}),
    },
  });

  // Adopt the authenticated subscriber's account onto the device when it is
  // missing or stale. `updateMany` with the `not` predicate is a single
  // conditional UPDATE (no read-modify-write race) that touches the row only
  // when it actually needs changing. Skipped entirely for unauthenticated
  // (legacy) subscribes.
  if (accountId !== undefined) {
    await tx.deviceRegistration.updateMany({
      where: {
        deviceId,
        OR: [{ accountId: null }, { accountId: { not: accountId } }],
      },
      data: { accountId },
    });
  }
}

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

    // Create or update client identifier record and (when authenticated)
    // adopt the subscriber's account onto the device. accountId is sourced
    // from the JWT and is what the webhook delivery guard compares against
    // the joined DeviceRegistration.accountId before sending a push. Older
    // iOS builds that authenticate without SIWE produce a JWT with no
    // accountId; leave both fields untouched in that case so the migration
    // backfill value (or a prior accountId from a SIWE authentication on
    // the same row) is not clobbered. Both writes share one transaction so
    // the ClientIdentifier and DeviceRegistration never disagree mid-flight.
    // See persistSubscriptionIdentity for the full rationale + safety notes.
    const accountId = res.locals.accountId;
    try {
      await prisma.$transaction((tx) =>
        persistSubscriptionIdentity({
          tx,
          clientId: body.clientId,
          deviceId: body.deviceId,
          accountId,
        }),
      );
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
    req.log.error({ error }, "Failed to subscribe to topics");
    res.status(500).json({ error: "Failed to subscribe to topics" });
    return;
  }
}
