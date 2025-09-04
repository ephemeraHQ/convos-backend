import { type Request, type Response } from "express";
import { z } from "zod";
import { prisma } from "@/utils/prisma";
import { DeviceSchema } from "../../../../../prisma/generated/zod";

export const DeviceInputSchema = DeviceSchema.pick({
  id: true,
  name: true,
  os: true,
  pushToken: true,
  pushTokenType: true,
  apnsEnv: true,
  appVersion: true,
  appBuildNumber: true,
}).partial({
  pushToken: true,
  pushTokenType: true,
  apnsEnv: true,
  appVersion: true,
  appBuildNumber: true,
});

export type CreateDeviceRequestBody = z.infer<typeof DeviceInputSchema>;

export async function createDeviceHandler(
  req: Request<unknown, unknown, CreateDeviceRequestBody>,
  res: Response,
) {
  try {
    const { xmtpId } = res.locals;

    // Verify the authenticated identity exists
    const identity = await prisma.deviceIdentity.findFirst({
      where: { xmtpId },
      select: { id: true },
    });

    if (!identity) {
      res
        .status(403)
        .json({ error: "Not authorized to create a device for this user" });
      return;
    }

    const validatedData = DeviceInputSchema.parse(req.body);

    const device = await prisma.$transaction(async (tx) => {
      const device = await tx.device.create({
        data: {
          ...validatedData,
          pushFailures: 0,
        },
      });
      // Associate device with the authenticated identity
      await tx.identitiesOnDevice.upsert({
        where: {
          deviceId_identityId: {
            deviceId: device.id,
            identityId: identity.id,
          },
        },
        create: {
          deviceId: device.id,
          identityId: identity.id,
        },
        update: {},
      });
      return device;
    });

    res.status(201).json(device);
  } catch (error) {
    if (error instanceof z.ZodError) {
      res
        .status(400)
        .json({ error: "Invalid request body", details: error.errors });
      return;
    }
    res.status(500).json({ error: "Failed to create device" });
  }
}
