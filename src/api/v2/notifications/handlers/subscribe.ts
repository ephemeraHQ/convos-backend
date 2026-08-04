import type { Prisma } from "@prisma/client";
import type { Request, Response } from "express";
import { hexToUint8Array } from "uint8array-extras";
import { z } from "zod";
import {
  AccountNotLiveError,
  requireLiveAccount,
} from "@/accounts/require-live-account";
import { createNotificationClient } from "@/notifications/client";
import {
  lockNotificationInstallation,
  notificationMutationCallOptions,
  withInstallationMutationFence,
  type InstallationExpectation,
  type InstallationGeneration,
} from "@/notifications/installation-mutation-fence";
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
type SubscribeRequest = Request<unknown, unknown, ISubscribeRequestBody>;

type SubscribeNotificationClient = Pick<
  ReturnType<typeof createNotificationClient>,
  "deleteInstallation" | "registerInstallation" | "subscribeWithMetadata"
>;

let notificationClient: SubscribeNotificationClient =
  createNotificationClient();
const SUBSCRIBE_TRANSACTION_TIMEOUT_MS = 10_000;
const SUBSCRIBE_FENCE_RETRIES = 3;

class SubscribeDeviceNotFoundError extends Error {}
class SubscribeDeviceDisabledError extends Error {}
class SubscribeFenceChangedError extends Error {}
class SubscribeInvalidatedError extends Error {}
class InstallationPurgePendingError extends Error {}

const sortedAccountIds = (
  ...accountIds: Array<string | null | undefined>
): string[] =>
  [
    ...new Set(
      accountIds.filter((id): id is string => id !== null && id !== undefined),
    ),
  ].sort();

export const __setSubscribeNotificationClientForTests = (
  client: SubscribeNotificationClient | null,
): void => {
  notificationClient = client ?? createNotificationClient();
};

export async function subscribe(req: SubscribeRequest, res: Response) {
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

    const subscriptions = body.topics.map((topic) => ({
      topic: topic.topic,
      isSilent: false,
      hmacKeys: topic.hmacKeys.map((key) => ({
        thirtyDayPeriodsSinceEpoch: key.thirtyDayPeriodsSinceEpoch,
        key: hexToUint8Array(key.key),
      })),
    }));

    const jwtAccountId = res.locals.accountId;
    let persisted:
      | Awaited<ReturnType<typeof persistClientIdentifier>>
      | undefined;
    for (let attempt = 0; attempt < SUBSCRIBE_FENCE_RETRIES; attempt += 1) {
      try {
        persisted = await persistClientIdentifier({
          clientId: body.clientId,
          deviceId: body.deviceId,
          jwtAccountId,
        });
        break;
      } catch (error) {
        if (
          error instanceof SubscribeFenceChangedError &&
          attempt + 1 < SUBSCRIBE_FENCE_RETRIES
        ) {
          continue;
        }
        throw error;
      }
    }
    if (!persisted) {
      throw new SubscribeFenceChangedError();
    }

    if (!persisted.pushToken) {
      req.log.info(
        {
          accountId: persisted.accountId,
          deviceId: body.deviceId,
          clientId: body.clientId,
        },
        "Device has no push token yet - subscription will be activated once token is registered",
      );
      res.status(200).send();
      return;
    }

    const pushToken = persisted.pushToken;
    const persistedGeneration: InstallationGeneration = {
      accountId: persisted.accountId,
      deviceAccountId: persisted.deviceAccountId,
      deviceId: persisted.deviceId,
      updatedAt: persisted.updatedAt,
    };
    try {
      const registration = await withInstallationMutationFence({
        installationId: body.clientId,
        expectation: { state: "present", generation: persistedGeneration },
        mutate: () =>
          notificationClient.registerInstallation(
            {
              installationId: body.clientId,
              deliveryMechanism: {
                deliveryMechanismType: {
                  case:
                    persisted.pushTokenType === "apns"
                      ? "apnsDeviceToken"
                      : "firebaseDeviceToken",
                  value: pushToken,
                },
              },
            },
            notificationMutationCallOptions(),
          ),
      });
      if (!registration.applied) {
        if (registration.current === null) {
          throw new SubscribeInvalidatedError();
        }
        req.log.info(
          { clientId: body.clientId },
          "notifications.subscribe.superseded",
        );
        res.status(200).send();
        return;
      }
      const subscription = await withInstallationMutationFence({
        installationId: body.clientId,
        expectation: { state: "present", generation: persistedGeneration },
        mutate: () =>
          notificationClient.subscribeWithMetadata(
            { installationId: body.clientId, subscriptions },
            notificationMutationCallOptions(),
          ),
      });
      if (!subscription.applied) {
        if (subscription.current === null) {
          await compensateRemoteInstallation(req, {
            expectation: { state: "absent" },
            installationId: body.clientId,
          });
          throw new SubscribeInvalidatedError();
        }
        req.log.info(
          { clientId: body.clientId },
          "notifications.subscribe.superseded",
        );
        res.status(200).send();
        return;
      }
    } catch (remoteError) {
      if (remoteError instanceof SubscribeInvalidatedError) {
        throw remoteError;
      }
      await compensateRemoteInstallation(req, {
        expectation: { state: "present", generation: persistedGeneration },
        installationId: body.clientId,
      });
      throw remoteError;
    }

    const current = await prisma.clientIdentifier.findUnique({
      where: { id: body.clientId },
      include: { device: { select: { accountId: true } } },
    });
    if (!current) {
      await compensateRemoteInstallation(req, {
        expectation: { state: "absent" },
        installationId: body.clientId,
      });
      throw new SubscribeInvalidatedError();
    }

    // A newer subscribe owns the shared installation id. Its remote state
    // must not be removed by this request's post-registration cleanup.
    if (
      current.updatedAt.getTime() !== persisted.updatedAt.getTime() ||
      current.accountId !== persisted.accountId ||
      current.deviceId !== persisted.deviceId ||
      current.device.accountId !== persisted.deviceAccountId
    ) {
      req.log.info(
        { clientId: body.clientId },
        "notifications.subscribe.superseded",
      );
      res.status(200).send();
      return;
    }

    const currentOwnerIds = sortedAccountIds(
      current.accountId,
      current.device.accountId,
    );
    if (currentOwnerIds.length > 0) {
      const liveOwners = await prisma.account.count({
        where: { id: { in: currentOwnerIds } },
      });
      if (liveOwners !== currentOwnerIds.length) {
        await compensateRemoteInstallation(req, {
          expectation: { state: "present", generation: persistedGeneration },
          installationId: body.clientId,
        });
        throw new SubscribeInvalidatedError();
      }
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
    if (error instanceof SubscribeDeviceNotFoundError) {
      req.log.warn(
        { deviceId: res.locals.deviceId },
        "Device not found for subscribe",
      );
      res.status(404).json({ error: "Device not found" });
      return;
    }
    if (error instanceof SubscribeDeviceDisabledError) {
      req.log.warn({ deviceId: res.locals.deviceId }, "Device is disabled");
      res.status(403).json({ error: "Device is disabled" });
      return;
    }
    if (error instanceof InstallationPurgePendingError) {
      req.log.warn(
        { clientId: req.body.clientId },
        "notifications.subscribe.purge_pending",
      );
      res.setHeader("Retry-After", "5");
      res.status(503).json({ error: "Installation cleanup in progress" });
      return;
    }
    if (
      error instanceof AccountNotLiveError ||
      error instanceof SubscribeInvalidatedError
    ) {
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

const persistClientIdentifier = async (args: {
  clientId: string;
  deviceId: string;
  jwtAccountId: string | undefined;
}) =>
  prisma.$transaction(
    async (tx) => {
      const initialDevice = await tx.deviceRegistration.findUnique({
        where: { deviceId: args.deviceId },
      });
      if (!initialDevice) throw new SubscribeDeviceNotFoundError();
      const initialPrior = await tx.clientIdentifier.findUnique({
        where: { id: args.clientId },
        select: { accountId: true, updatedAt: true },
      });
      const initialOwnerIds = sortedAccountIds(
        args.jwtAccountId,
        initialDevice.accountId,
        initialPrior?.accountId,
      );
      for (const accountId of initialOwnerIds) {
        await requireLiveAccount(tx, accountId);
      }
      await lockNotificationInstallation(tx, args.clientId);

      // Account rows are locked first. The mutable rows are then locked and
      // re-read so an ownership change that committed while account locks
      // were being acquired restarts with the complete, sorted owner set.
      await tx.$queryRaw`
        SELECT 1 FROM "DeviceRegistration"
        WHERE "deviceId" = ${args.deviceId}
        FOR UPDATE
      `;
      if (initialPrior) {
        await tx.$queryRaw`
          SELECT 1 FROM "ClientIdentifier"
          WHERE id = ${args.clientId}
          FOR UPDATE
        `;
      }
      const device = await tx.deviceRegistration.findUnique({
        where: { deviceId: args.deviceId },
      });
      if (!device) throw new SubscribeDeviceNotFoundError();
      const prior = await tx.clientIdentifier.findUnique({
        where: { id: args.clientId },
        select: { accountId: true, updatedAt: true },
      });
      const ownerIds = sortedAccountIds(
        args.jwtAccountId,
        device.accountId,
        prior?.accountId,
      );
      if (ownerIds.join("\0") !== initialOwnerIds.join("\0")) {
        throw new SubscribeFenceChangedError();
      }
      if (device.disabled) throw new SubscribeDeviceDisabledError();

      const unfinishedPurge = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM "DeletionTask"
        WHERE kind = 'notification_installation'
          AND status <> 'done'
          AND payload->>'installationId' = ${args.clientId}
        LIMIT 1
      `;
      if (unfinishedPurge.length > 0) {
        throw new InstallationPurgePendingError();
      }

      const accountId =
        args.jwtAccountId ?? device.accountId ?? prior?.accountId ?? undefined;
      // The per-installation advisory lock makes this a monotonic write
      // generation, even when two subscribes land in the same millisecond.
      const updatedAt = new Date(
        Math.max(Date.now(), (prior?.updatedAt.getTime() ?? 0) + 1),
      );
      const identifier = await tx.clientIdentifier.upsert({
        where: { id: args.clientId },
        create: {
          id: args.clientId,
          deviceId: args.deviceId,
          accountId,
          updatedAt,
        },
        update: {
          deviceId: args.deviceId,
          updatedAt,
          ...(accountId !== undefined ? { accountId } : {}),
        },
        select: { accountId: true, deviceId: true, updatedAt: true },
      });
      // Device adoption, mirroring persistSubscriptionIdentity (which the
      // unit tests pin): an authenticated subscribe adopts the subscriber's
      // account onto the device when it is missing or stale, healing
      // NULL DeviceRegistration.accountId push drops. It runs inline here —
      // not via the helper — because this fenced transaction already holds
      // the device row FOR UPDATE and the ClientIdentifier write above must
      // carry the fence's monotonic generation, which the helper's plain
      // upsert does not.
      if (args.jwtAccountId !== undefined) {
        await tx.deviceRegistration.updateMany({
          where: {
            deviceId: args.deviceId,
            OR: [
              { accountId: null },
              { accountId: { not: args.jwtAccountId } },
            ],
          },
          data: { accountId: args.jwtAccountId },
        });
      }
      return {
        ...identifier,
        // Post-adoption value: the generation snapshot must match what the
        // fence re-reads from the database after this transaction commits.
        deviceAccountId: args.jwtAccountId ?? device.accountId,
        pushToken: device.pushToken,
        pushTokenType: device.pushTokenType,
      };
    },
    { maxWait: 5_000, timeout: SUBSCRIBE_TRANSACTION_TIMEOUT_MS },
  );

const compensateRemoteInstallation = async (
  req: SubscribeRequest,
  args: {
    expectation: InstallationExpectation;
    installationId: string;
  },
): Promise<"cleaned" | "failed" | "superseded"> => {
  try {
    const result = await withInstallationMutationFence({
      installationId: args.installationId,
      expectation: args.expectation,
      mutate: async (tx) => {
        await notificationClient.deleteInstallation(
          { installationId: args.installationId },
          notificationMutationCallOptions(),
        );
        if (args.expectation.state === "present") {
          const generation = args.expectation.generation;
          await tx.clientIdentifier.deleteMany({
            where: {
              id: args.installationId,
              accountId: generation.accountId,
              deviceId: generation.deviceId,
              updatedAt: generation.updatedAt,
            },
          });
        }
      },
    });
    if (!result.applied) {
      req.log.info(
        { installationId: args.installationId },
        "notifications.subscribe.compensation_superseded",
      );
      return "superseded";
    }
    return "cleaned";
  } catch (cleanupError) {
    req.log.error(
      {
        error: cleanupError,
        installationId: args.installationId,
        requiresOperatorCleanup: true,
      },
      "notifications.subscribe.remote_cleanup_failed",
    );
    return "failed";
  }
};
