import { ApnsEnvironmentSchema, PushTokenTypeSchema } from "@prisma-zod/index";
import type { ApnsEnvironment, PushTokenType } from "@prisma/client";
import type { Request, Response } from "express";
import { z } from "zod";
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
  await prisma.$transaction(async (tx) => {
    // Track old devices and their client identifiers for migration
    let oldDeviceIds: string[] = [];
    let clientIdsToMigrate: string[] = [];

    // If a push token is provided, handle conflicts with other devices
    // We check across all apnsEnv values because the same physical device
    // can switch between sandbox (Xcode) and production (TestFlight) builds,
    // and Apple may issue the same push token for both environments.
    if (pushToken) {
      const tokenType = pushTokenType ?? "apns";

      // Find any other device with the same push token (regardless of apnsEnv)
      const existingDevices = await tx.deviceRegistration.findMany({
        where: {
          pushToken,
          pushTokenType: tokenType,
          deviceId: { not: deviceId },
        },
        include: {
          clientIdentifiers: true,
        },
      });

      if (existingDevices.length > 0) {
        oldDeviceIds = existingDevices.map((d) => d.deviceId);
        clientIdsToMigrate = existingDevices.flatMap((d) =>
          d.clientIdentifiers.map((c) => c.id),
        );

        logger.info(
          {
            oldDeviceIds,
            newDeviceId: deviceId,
            clientIdsToMigrate,
            hasPushToken: !!pushToken,
          },
          "Push token moving from old device(s) to new device - migrating client identifiers and clearing old registrations",
        );

        // Clear the push token from all old devices FIRST (before upsert to avoid unique constraint)
        await tx.deviceRegistration.updateMany({
          where: {
            deviceId: { in: oldDeviceIds },
          },
          data: { pushToken: null },
        });
      }
    }

    // Upsert the new device registration
    // This ensures the foreign key target exists
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

    // Migrate ClientIdentifiers from old devices to the new device
    // This must happen after the upsert so the FK target exists
    if (clientIdsToMigrate.length > 0) {
      await tx.clientIdentifier.updateMany({
        where: {
          id: { in: clientIdsToMigrate },
        },
        data: { deviceId },
      });
    }
  });
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
