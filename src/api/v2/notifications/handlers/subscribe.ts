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

type SubscribeNotificationClient = Pick<
  ReturnType<typeof createNotificationClient>,
  "deleteInstallation" | "registerInstallation" | "subscribeWithMetadata"
>;

let notificationClient: SubscribeNotificationClient =
  createNotificationClient();
const NOTIFICATION_RPC_TIMEOUT_MS = 10_000;
const SUBSCRIBE_TRANSACTION_TIMEOUT_MS = 45_000;

export const __setSubscribeNotificationClientForTests = (
  client: SubscribeNotificationClient | null,
): void => {
  notificationClient = client ?? createNotificationClient();
};

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

    // Persist the installation identity before making it visible remotely,
    // while holding the owning Account row lock through both remote calls.
    // Account deletion takes the conflicting lock, so it either runs first
    // and fences this request or runs afterwards and snapshots this row for
    // its purge outbox.
    const accountId = res.locals.accountId;
    const remote = { stateMayExist: false };
    let transactionResult:
      | { kind: "complete" }
      | { error: Error; kind: "remote_failure_preserved" };
    try {
      transactionResult = await prisma.$transaction(
        async (tx) => {
          const prior = await tx.clientIdentifier.findUnique({
            where: { id: body.clientId },
            select: { accountId: true },
          });
          const fencedAccountId =
            accountId ?? device.accountId ?? prior?.accountId ?? undefined;
          if (fencedAccountId !== undefined) {
            await requireLiveAccount(tx, fencedAccountId);
          }
          await tx.clientIdentifier.upsert({
            where: { id: body.clientId },
            create: {
              id: body.clientId,
              deviceId: body.deviceId,
              accountId: fencedAccountId,
            },
            update: {
              deviceId: body.deviceId,
              ...(fencedAccountId !== undefined
                ? { accountId: fencedAccountId }
                : {}),
            },
          });

          if (!device.pushToken) {
            req.log.info(
              {
                accountId: fencedAccountId,
                deviceId: body.deviceId,
                clientId: body.clientId,
              },
              "Device has no push token yet - subscription will be activated once token is registered",
            );
            return { kind: "complete" as const };
          }

          try {
            // The server may accept registration even if the client loses the
            // response, so cleanup must assume remote state exists once the
            // call starts.
            remote.stateMayExist = true;
            await notificationClient.registerInstallation(
              {
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
              },
              { timeoutMs: NOTIFICATION_RPC_TIMEOUT_MS },
            );
            await notificationClient.subscribeWithMetadata(
              {
                installationId: body.clientId,
                subscriptions,
              },
              { timeoutMs: NOTIFICATION_RPC_TIMEOUT_MS },
            );
            return { kind: "complete" as const };
          } catch (remoteErr) {
            const remoteError =
              remoteErr instanceof Error
                ? remoteErr
                : new Error(String(remoteErr));
            try {
              await notificationClient.deleteInstallation(
                {
                  installationId: body.clientId,
                },
                { timeoutMs: NOTIFICATION_RPC_TIMEOUT_MS },
              );
              remote.stateMayExist = false;
            } catch (cleanupErr) {
              // Commit the ClientIdentifier so a later account deletion still
              // has a durable purge target. The event is an explicit operator
              // alert for the partially registered installation.
              req.log.error(
                {
                  error: cleanupErr,
                  installationId: body.clientId,
                  requiresOperatorCleanup: true,
                },
                "notifications.subscribe.remote_cleanup_failed",
              );
              return {
                error: remoteError,
                kind: "remote_failure_preserved" as const,
              };
            }
            throw remoteError;
          }
        },
        { maxWait: 5_000, timeout: SUBSCRIBE_TRANSACTION_TIMEOUT_MS },
      );
    } catch (dbErr) {
      // A commit failure can happen after successful remote registration.
      // Remove that remote state before surfacing the database failure.
      if (remote.stateMayExist) {
        try {
          await notificationClient.deleteInstallation(
            {
              installationId: body.clientId,
            },
            { timeoutMs: NOTIFICATION_RPC_TIMEOUT_MS },
          );
        } catch (cleanupErr) {
          req.log.error(
            {
              error: cleanupErr,
              installationId: body.clientId,
              requiresOperatorCleanup: true,
            },
            "notifications.subscribe.remote_cleanup_failed",
          );
        }
      }
      throw dbErr;
    }
    if (transactionResult.kind === "remote_failure_preserved") {
      throw transactionResult.error;
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
      // 401 like every other fail-closed route. The fence runs before remote
      // registration, so this path cannot create an installation.
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
