import { ApnsEnvironmentSchema, PushTokenTypeSchema } from "@prisma-zod/index";
import type { ApnsEnvironment, PushTokenType } from "@prisma/client";
import type { Request, Response } from "express";
import { z } from "zod";
import { prisma } from "@/utils/prisma";

const registerRequestSchema = z.object({
  deviceId: z.string().min(1).max(255),
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
        pushTokenType: body.pushTokenType,
        apnsEnv: body.apnsEnv,
      },
      "Registering device",
    );

    // Build update data - only include fields that were explicitly provided
    const updateData: {
      pushTokenType?: PushTokenType;
      apnsEnv?: ApnsEnvironment | null;
      pushToken?: string;
    } = {};

    if (body.pushToken !== undefined) {
      updateData.pushToken = body.pushToken;
    }
    if (body.pushTokenType !== undefined) {
      updateData.pushTokenType = body.pushTokenType;
    }
    if (body.apnsEnv !== undefined) {
      updateData.apnsEnv = body.apnsEnv;
    }

    // Use upsert to avoid race conditions
    // On create: use defaults for missing fields
    // On update: only update fields that were provided
    await prisma.deviceRegistration.upsert({
      where: { deviceId: body.deviceId },
      create: {
        deviceId: body.deviceId,
        pushToken: body.pushToken ?? null,
        pushTokenType: body.pushTokenType ?? "apns",
        apnsEnv: body.apnsEnv ?? null,
      },
      update: updateData,
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
    req.log.error({ error }, "Failed to register device");
    res.status(500).json({ error: "Failed to register device" });
  }
}
