import { ApnsEnvironmentSchema, PushTokenTypeSchema } from "@prisma-zod/index";
import type { ApnsEnvironment, Prisma, PushTokenType } from "@prisma/client";
import type { Request, Response } from "express";
import { z } from "zod";
import { requireLiveAccount } from "@/accounts/require-live-account";
import { lockNotificationInstallation } from "@/notifications/installation-mutation-fence";
import { deviceIdSchema } from "@/utils/device-id";
import { prisma } from "@/utils/prisma";

const registerRequestSchema = z.object({
  deviceId: deviceIdSchema,
  pushToken: z
    .string()
    .optional()
    .transform((val) => (!val || val.trim() === "" ? undefined : val)),
  pushTokenType: PushTokenTypeSchema.optional(),
  apnsEnv: ApnsEnvironmentSchema.nullable().optional(),
});

export type IRegisterRequestBody = z.infer<typeof registerRequestSchema>;

const DEVICE_REGISTRATION_FENCE_RETRIES = 3;
class DeviceRegistrationFenceChangedError extends Error {}

let beforeAccountLocksForTests: (() => Promise<void>) | null = null;
export const __setDeviceRegistrationBeforeAccountLocksForTests = (
  hook: (() => Promise<void>) | null,
): void => {
  beforeAccountLocksForTests = hook;
};

const loadDeviceRegistrationState = async (
  tx: Prisma.TransactionClient,
  args: {
    deviceId: string;
    pushToken: string | undefined;
    pushTokenType: PushTokenType | undefined;
  },
) => {
  const targetDevice = await tx.deviceRegistration.findUnique({
    where: { deviceId: args.deviceId },
    include: { clientIdentifiers: true },
  });
  const sourceDevices = args.pushToken
    ? await tx.deviceRegistration.findMany({
        where: {
          pushToken: args.pushToken,
          pushTokenType: args.pushTokenType ?? "apns",
          deviceId: { not: args.deviceId },
        },
        include: { clientIdentifiers: true },
        orderBy: { deviceId: "asc" },
      })
    : [];
  const clientIdsToMigrate = [
    ...new Set(
      sourceDevices.flatMap((device) =>
        device.clientIdentifiers.map((client) => client.id),
      ),
    ),
  ].sort();
  const accountIds = [
    ...new Set(
      [targetDevice, ...sourceDevices]
        .flatMap((device) => [
          device?.accountId,
          ...(device?.clientIdentifiers.map((client) => client.accountId) ??
            []),
        ])
        .filter(
          (accountId): accountId is string => typeof accountId === "string",
        ),
    ),
  ].sort();
  const deviceIds = [
    ...new Set([
      args.deviceId,
      ...sourceDevices.map((device) => device.deviceId),
    ]),
  ].sort();
  const signature = JSON.stringify({
    target: targetDevice
      ? {
          accountId: targetDevice.accountId,
          clientIdentifiers: targetDevice.clientIdentifiers
            .map((client) => [client.id, client.accountId])
            .sort(),
          deviceId: targetDevice.deviceId,
        }
      : null,
    sources: sourceDevices.map((device) => ({
      accountId: device.accountId,
      clientIdentifiers: device.clientIdentifiers
        .map((client) => [client.id, client.accountId])
        .sort(),
      deviceId: device.deviceId,
    })),
  });
  return {
    accountIds,
    clientIdsToMigrate,
    deviceIds,
    signature,
    sourceDevices,
  };
};

/**
 * Helper function to perform the device registration transaction.
 * This handles clearing conflicting push tokens and upserting the device registration.
 */
async function performDeviceRegistration(
  deviceId: string,
  pushToken: string | undefined,
  pushTokenType: PushTokenType | undefined,
  apnsEnv: ApnsEnvironment | null | undefined,
  updateData: {
    pushTokenType?: PushTokenType;
    apnsEnv?: ApnsEnvironment | null;
    pushToken?: string | null;
  },
  logger: Request["log"],
) {
  for (
    let attempt = 0;
    attempt < DEVICE_REGISTRATION_FENCE_RETRIES;
    attempt += 1
  ) {
    try {
      await prisma.$transaction(async (tx) => {
        const initial = await loadDeviceRegistrationState(tx, {
          deviceId,
          pushToken,
          pushTokenType,
        });
        await beforeAccountLocksForTests?.();

        // Account locks are always first and sorted. Deletion either observes
        // the completed migration in its snapshot or removes the Account and
        // makes requireLiveAccount fail before any attachment can occur.
        for (const accountId of initial.accountIds) {
          await requireLiveAccount(tx, accountId);
        }
        for (const clientId of initial.clientIdsToMigrate) {
          await lockNotificationInstallation(tx, clientId);
        }
        for (const lockedDeviceId of initial.deviceIds) {
          await tx.$queryRaw`
            SELECT 1 FROM "DeviceRegistration"
            WHERE "deviceId" = ${lockedDeviceId}
            FOR UPDATE
          `;
        }

        const current = await loadDeviceRegistrationState(tx, {
          deviceId,
          pushToken,
          pushTokenType,
        });
        if (current.signature !== initial.signature) {
          throw new DeviceRegistrationFenceChangedError();
        }

        const oldDeviceIds = current.sourceDevices.map(
          (source) => source.deviceId,
        );
        if (oldDeviceIds.length > 0) {
          logger.info(
            {
              oldDeviceIds,
              newDeviceId: deviceId,
              clientIdsToMigrate: current.clientIdsToMigrate,
              hasPushToken: !!pushToken,
            },
            "Push token moving from old device(s) to new device - migrating client identifiers and clearing old registrations",
          );
          await tx.deviceRegistration.updateMany({
            where: { deviceId: { in: oldDeviceIds } },
            data: { pushToken: null },
          });
        }

        await tx.deviceRegistration.upsert({
          where: { deviceId },
          create: {
            deviceId,
            pushToken: pushToken ?? null,
            pushTokenType: pushTokenType ?? "apns",
            apnsEnv: apnsEnv ?? null,
          },
          update: updateData,
        });

        if (current.clientIdsToMigrate.length > 0) {
          await tx.clientIdentifier.updateMany({
            where: { id: { in: current.clientIdsToMigrate } },
            data: { deviceId },
          });
        }
      });
      return;
    } catch (error) {
      if (
        error instanceof DeviceRegistrationFenceChangedError &&
        attempt + 1 < DEVICE_REGISTRATION_FENCE_RETRIES
      ) {
        continue;
      }
      throw error;
    }
  }
}

export async function register(
  req: Request<unknown, unknown, IRegisterRequestBody>,
  res: Response,
) {
  try {
    const body = registerRequestSchema.parse(req.body);

    req.log.info(
      {
        deviceId: body.deviceId,
        hasPushToken: !!body.pushToken,
        pushTokenType: body.pushTokenType,
        apnsEnv: body.apnsEnv,
      },
      "Registering device",
    );

    // Build update data - only include fields that were explicitly provided
    const updateData: {
      pushTokenType?: PushTokenType;
      apnsEnv?: ApnsEnvironment | null;
      pushToken?: string | null;
    } = {};

    if (body.pushToken !== undefined) {
      // Normalize: undefined or empty string -> null
      updateData.pushToken = body.pushToken || null;
    }
    if (body.pushTokenType !== undefined) {
      updateData.pushTokenType = body.pushTokenType;
    }
    if (body.apnsEnv !== undefined) {
      updateData.apnsEnv = body.apnsEnv;
    }

    // Use transaction to handle push token conflicts
    // If this push token is already registered to a different device,
    // we need to transfer ownership to the new device
    await performDeviceRegistration(
      body.deviceId,
      body.pushToken,
      body.pushTokenType,
      body.apnsEnv,
      updateData,
      req.log,
    );

    req.log.info(
      { deviceId: body.deviceId, hasPushToken: !!body.pushToken },
      "Device registered successfully",
    );

    res.status(200).send();
    return;
  } catch (error) {
    if (error instanceof z.ZodError) {
      req.log.warn(
        { errors: error.errors },
        "Invalid request body for register",
      );
      res.status(400).json({ error: "Invalid request body" });
      return;
    }

    req.log.error({ error }, "Failed to register device");
    res.status(500).json({ error: "Failed to register device" });
    return;
  }
}
