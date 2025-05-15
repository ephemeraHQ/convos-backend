import { type Request, type Response } from "express";
import { prisma } from "@/utils/prisma";

export type LinkDeviceRequestParams = {
  identityId: string;
};

export type LinkDeviceRequestBody = {
  deviceId: string;
};

// POST /identities/:identityId/link - Link an existing identity to a device
export const linkDeviceToIdentity = async (
  req: Request<LinkDeviceRequestParams, unknown, LinkDeviceRequestBody>,
  res: Response,
) => {
  try {
    const { identityId } = req.params;
    const { deviceId } = req.body;
    const { xmtpId, xmtpInstallationId } = req.app.locals;

    if (!deviceId) {
      res.status(400).json({ error: "deviceId is required in request body" });
      return;
    }

    // Verify the identity belongs to the authenticated user
    const identity = await prisma.deviceIdentity.findFirst({
      where: {
        id: identityId,
        xmtpId,
      },
    });

    if (!identity) {
      res.status(403).json({ error: "Not authorized to link this identity" });
      return;
    }

    // Find the device
    const device = await prisma.device.findUnique({
      where: { id: deviceId },
      include: { user: true },
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
      res.status(403).json({ error: "Not authorized to link to this device" });
      return;
    }

    const identityOnDevice = await prisma.identitiesOnDevice.upsert({
      where: {
        deviceId_identityId: {
          deviceId,
          identityId,
        },
      },
      update: {
        xmtpInstallationId: xmtpInstallationId,
      },
      create: {
        deviceId,
        identityId,
        xmtpInstallationId: xmtpInstallationId,
      },
    });

    res.status(201).json(identityOnDevice);
  } catch {
    res.status(500).json({ error: "Failed to link identity to device" });
  }
};
