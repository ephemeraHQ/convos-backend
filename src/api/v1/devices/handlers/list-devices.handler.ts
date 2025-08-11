import { type Request, type Response } from "express";
import { prisma } from "@/utils/prisma";

export type GetDevicesRequestParams = {
  userId: string;
};

export async function listDevicesHandler(
  req: Request<GetDevicesRequestParams>,
  res: Response,
) {
  try {
    const { userId } = req.params;
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

    // Get all devices associated with this user
    const devices = await prisma.device.findMany({
      where: {
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

    res.json(devices);
  } catch (error) {
    req.log.error({ error }, "Failed to fetch devices");
    res.status(500).json({ error: "Failed to fetch devices" });
  }
}
