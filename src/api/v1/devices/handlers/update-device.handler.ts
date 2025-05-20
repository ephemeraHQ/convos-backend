import { type Request, type Response } from "express";
import { z } from "zod";
import { prisma } from "@/utils/prisma";
import { DeviceSchema } from "../../../../../prisma/generated/zod";

export type UpdateDeviceRequestParams = {
  userId: string;
  deviceId: string;
};

const DeviceUpdateInputSchema = DeviceSchema.pick({
  name: true,
  os: true,
  pushToken: true,
  expoToken: true,
  appVersion: true,
  buildNumber: true,
}).partial();

export type UpdateDeviceRequestBody = z.infer<typeof DeviceUpdateInputSchema>;

export async function updateDeviceHandler(
  req: Request<UpdateDeviceRequestParams, unknown, UpdateDeviceRequestBody>,
  res: Response,
) {
  try {
    const { userId, deviceId } = req.params;
    const { xmtpId } = req.app.locals;

    // First find the user to verify they exist and are the authenticated user
    const user = await prisma.user.findFirst({
      where: {
        id: userId,
        DeviceIdentity: {
          some: {
            xmtpId,
          },
        },
      },
    });

    if (!user) {
      res
        .status(403)
        .json({ error: "Not authorized to update this user's device" });
      return;
    }

    const validatedData = DeviceUpdateInputSchema.parse(req.body);

    const device = await prisma.device.update({
      where: {
        id: deviceId,
        userId,
      },
      data: validatedData,
    });

    res.json(device);
  } catch (error) {
    if (error instanceof z.ZodError) {
      res
        .status(400)
        .json({ error: "Invalid request body", details: error.errors });
      return;
    }
    res.status(500).json({ error: "Failed to update device" });
  }
}
