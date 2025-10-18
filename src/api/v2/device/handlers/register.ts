import { ApnsEnvironmentSchema, PushTokenTypeSchema } from "@prisma-zod/index";
import type { ApnsEnvironment, PushTokenType } from "@prisma/client";
import type { Request, Response } from "express";
import { z } from "zod";
import { prisma } from "@/utils/prisma";

const registerRequestSchema = z.object({
  deviceId: z.string().uuid(),
  pushToken: z
    .string()
    .optional()
    .transform((val) => (!val || val.trim() === "" ? undefined : val)),
  pushTokenType: PushTokenTypeSchema.optional(),
  apnsEnv: ApnsEnvironmentSchema.nullable().optional(),
});

export type IRegisterRequestBody = z.infer<typeof registerRequestSchema>;

export async function register(
  req: Request<unknown, unknown, IRegisterRequestBody>,
  res: Response,
) {
  try {
    const body = registerRequestSchema.parse(req.body);

    // Reject FCM as it is not supported
    if (body.pushTokenType === "fcm") {
      req.log.warn(
        { deviceId: body.deviceId },
        "FCM push token type is not supported",
      );
      res.status(400).json({
        error:
          "FCM push notifications are not supported. Only APNS is supported.",
      });
      return;
    }

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
    await prisma.$transaction(async (tx) => {
      // If a push token is provided, check if it's registered to another device
      if (body.pushToken) {
        const pushTokenType = body.pushTokenType ?? "apns";
        const apnsEnv = body.apnsEnv ?? null;

        // Find any other device with the same push token combination
        const existingDevice = await tx.deviceRegistration.findFirst({
          where: {
            pushToken: body.pushToken,
            pushTokenType,
            apnsEnv,
            deviceId: { not: body.deviceId },
          },
        });

        if (existingDevice) {
          req.log.info(
            {
              oldDeviceId: existingDevice.deviceId,
              newDeviceId: body.deviceId,
              pushToken: body.pushToken,
            },
            "Push token moving from old device to new device - clearing old registration",
          );

          // Clear the push token from the old device to avoid unique constraint violation
          await tx.deviceRegistration.update({
            where: { deviceId: existingDevice.deviceId },
            data: {
              pushToken: null,
              pushTokenType: "apns",
              apnsEnv: null,
            },
          });
        }
      }

      // Now upsert the new device registration
      await tx.deviceRegistration.upsert({
        where: { deviceId: body.deviceId },
        create: {
          deviceId: body.deviceId,
          pushToken: body.pushToken ?? null,
          pushTokenType: body.pushTokenType ?? "apns",
          apnsEnv: body.apnsEnv ?? null,
        },
        update: updateData,
      });
    });

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

    // Handle unique constraint violations - just update with latest data (idempotent)
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "P2002"
    ) {
      const deviceId = req.body.deviceId;
      const pushToken = req.body.pushToken;
      const pushTokenType = req.body.pushTokenType;
      const apnsEnv = req.body.apnsEnv;

      req.log.info(
        { deviceId, hasPushToken: !!pushToken },
        "Conflict detected - updating device with latest data (idempotent)",
      );

      try {
        // Build update data from the request body
        const conflictUpdateData: {
          pushTokenType?: PushTokenType;
          apnsEnv?: ApnsEnvironment | null;
          pushToken?: string | null;
        } = {};

        if (pushToken !== undefined) {
          conflictUpdateData.pushToken = pushToken || null;
        }
        if (pushTokenType !== undefined) {
          conflictUpdateData.pushTokenType = pushTokenType;
        }
        if (apnsEnv !== undefined) {
          conflictUpdateData.apnsEnv = apnsEnv;
        }

        // If pushToken conflict: clear it from other devices first
        if (pushToken) {
          await prisma.deviceRegistration.updateMany({
            where: {
              pushToken,
              deviceId: { not: deviceId },
            },
            data: {
              pushToken: null,
              apnsEnv: null,
            },
          });
        }

        // Update this device
        await prisma.deviceRegistration.update({
          where: { deviceId },
          data: conflictUpdateData,
        });

        req.log.info(
          { deviceId, hasPushToken: !!pushToken },
          "Device updated successfully",
        );

        res.status(200).send();
        return;
      } catch (updateError) {
        req.log.error(
          { error: updateError, deviceId },
          "Failed to update device after conflict",
        );
        res.status(500).json({ error: "Failed to register device" });
        return;
      }
    }

    req.log.error({ error }, "Failed to register device");
    res.status(500).json({ error: "Failed to register device" });
    return;
  }
}
