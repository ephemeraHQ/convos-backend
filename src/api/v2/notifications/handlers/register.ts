import { ApnsEnvironmentSchema, PushTokenTypeSchema } from "@prisma-zod/index";
import type { Request, Response } from "express";
import { z } from "zod";
import { prisma } from "@/utils/prisma";

const registerRequestSchema = z.object({
  deviceId: z.string(),
  pushToken: z.string(),
  tokenType: PushTokenTypeSchema.optional(),
  apnsEnv: ApnsEnvironmentSchema.nullable().optional(),
});

export type IRegisterRequestBody = z.infer<typeof registerRequestSchema>;

export async function register(
  req: Request<unknown, unknown, IRegisterRequestBody>,
  res: Response,
) {
  try {
    const body = registerRequestSchema.parse(req.body);

    await prisma.deviceRegistration.upsert({
      where: { deviceId: body.deviceId },
      create: {
        deviceId: body.deviceId,
        pushToken: body.pushToken,
        tokenType: body.tokenType ?? "apns",
        apnsEnv: body.apnsEnv ?? null,
      },
      update: {
        pushToken: body.pushToken,
        tokenType: body.tokenType ?? "apns",
        apnsEnv: body.apnsEnv ?? null,
        updatedAt: new Date(),
      },
    });

    res.status(200).send();
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Invalid request body" });
      return;
    }
    req.log.error({ error }, "Failed to register device");
    res.status(500).json({ error: "Failed to register device" });
  }
}
