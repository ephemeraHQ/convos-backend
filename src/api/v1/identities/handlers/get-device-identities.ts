import { type Request, type Response } from "express";
import { prisma } from "@/utils/prisma";

export type GetDeviceIdentitiesRequestParams = {
  deviceId: string;
};

// GET /identities/device/:deviceId - Get all identities for a device
export const getDeviceIdentities = async (
  req: Request<GetDeviceIdentitiesRequestParams>,
  res: Response,
) => {
  try {
    const { deviceId } = req.params;
    const { xmtpId } = req.app.locals;

    // First find the device
    const device = await prisma.device.findUnique({
      where: { id: deviceId },
      include: {
        user: true,
        identities: {
          include: {
            identity: true,
          },
        },
      },
    });

    if (!device) {
      res.status(404).json({ error: "Device not found" });
      return;
    }

    // Check if the authenticated user has access to this device
    const hasAccess = await prisma.deviceIdentity.findFirst({
      where: {
        xmtpId,
        userId: device.userId,
      },
    });

    if (!hasAccess) {
      res.status(403).json({ error: "Not authorized to access this device" });
      return;
    }

    // Transform the response to return just the identities
    const identities = device.identities.map((item) => item.identity);

    res.json(identities);
  } catch {
    res.status(500).json({ error: "Failed to fetch device identities" });
  }
};
