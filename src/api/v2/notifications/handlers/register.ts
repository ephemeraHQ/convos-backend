import { ApnsEnvironmentSchema, PushTokenTypeSchema } from "@prisma-zod/index";
import type { ApnsEnvironment, PushTokenType } from "@prisma/client";
import type { Request, Response } from "express";
import { z } from "zod";
import { prisma } from "@/utils/prisma";

const registerRequestSchema = z.object({
  deviceId: z.string(),
  pushToken: z.string().optional(),
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

    req.log.info(
      {
        deviceId: body.deviceId,
        hasPushToken: !!body.pushToken,
        pushTokenType: body.pushTokenType ?? "apns",
        apnsEnv: body.apnsEnv,
      },
      "Registering device",
    );

    // Check if device exists
    const existingDevice = await prisma.deviceRegistration.findUnique({
      where: { deviceId: body.deviceId },
    });

    if (existingDevice) {
      // Update existing device - only update pushToken if provided
      const updateData: {
        pushTokenType?: PushTokenType;
        apnsEnv?: ApnsEnvironment | null;
        pushToken?: string;
      } = {
        pushTokenType: body.pushTokenType ?? "apns",
        apnsEnv: body.apnsEnv ?? null,
      };

      if (body.pushToken) {
        updateData.pushToken = body.pushToken;
      }

      await prisma.deviceRegistration.update({
        where: { deviceId: body.deviceId },
        data: updateData,
      });

      req.log.info(
        { deviceId: body.deviceId, updatedPushToken: !!body.pushToken },
        "Device updated successfully",
      );
    } else {
      // Create new device - pushToken can be empty initially
      await prisma.deviceRegistration.create({
        data: {
          deviceId: body.deviceId,
          pushToken: body.pushToken ?? "",
          pushTokenType: body.pushTokenType ?? "apns",
          apnsEnv: body.apnsEnv ?? null,
        },
      });

      req.log.info(
        { deviceId: body.deviceId, hasPushToken: !!body.pushToken },
        "Device registered successfully",
      );
    }
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
  }
}
