import { type Request, type Response } from "express";
import { prisma } from "@/utils/prisma";

export type GetDeviceRequestParams = {
  userId: string;
  deviceId: string;
};

export async function getDeviceHandler(
  req: Request<GetDeviceRequestParams>,
  res: Response,
) {
  try {
    const { userId, deviceId } = req.params;
    const { xmtpId } = req.app.locals;

    // First find the user to verify they exist and are the authenticated user
    const user = await prisma.user.findFirst({
      where: {
        userId: userId,
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
        .json({ error: "Not authorized to access this user's devices" });
      return;
    }

    // Check if device exists and is associated with the user
    const device = await prisma.device.findFirst({
      where: {
        id: deviceId,
        users: {
          some: {
            userId: user.id,
          },
        },
      },
      select: {
        id: true,
        name: true,
        os: true,
        pushToken: true,
        pushTokenType: true,
        apnsEnv: true,
        appVersion: true,
        appBuildNumber: true,
        createdAt: true,
        updatedAt: true,
        lastPushSuccessAt: true,
        pushFailures: true,
      },
    });

    if (!device) {
      res
        .status(404)
        .json({ error: "Device not found or not associated with this user" });
      return;
    }

    res.json(device);
  } catch {
    res.status(500).json({ error: "Failed to fetch device" });
  }
}
