import { type Request, type Response } from "express";
import { createNotificationClient } from "@/notifications/client";
import { prisma } from "@/utils/prisma";

export type UnlinkDeviceRequestParams = {
  identityId: string;
};

export type UnlinkDeviceRequestBody = {
  deviceId: string;
};

const notificationClient = createNotificationClient();

// DELETE /identities/:identityId/link - Unlink an identity from a device
export const unlinkDeviceFromIdentity = async (
  req: Request<UnlinkDeviceRequestParams, unknown, UnlinkDeviceRequestBody>,
  res: Response,
) => {
  try {
    const { identityId } = req.params;
    const { deviceId } = req.body;
    const { xmtpId } = req.app.locals;

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
      res.status(403).json({ error: "Not authorized to unlink this identity" });
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
      res
        .status(403)
        .json({ error: "Not authorized to unlink from this device" });
      return;
    }

    const identitiesOnDeviceToUnlink = await prisma.identitiesOnDevice.findMany(
      {
        where: {
          deviceId,
          identityId,
        },
      },
    );

    // Unregister from notifications. We make it allSettled because if this fails, it's not a big deal.
    // Because when sending a noticicatin, we chekc for identity on device anyway and if we can't find it, we also remove it there.
    const results = await Promise.allSettled(
      identitiesOnDeviceToUnlink
        .map((identityOnDevice) =>
          identityOnDevice.xmtpInstallationId
            ? notificationClient.deleteInstallation({
                installationId: identityOnDevice.xmtpInstallationId,
              })
            : undefined,
        )
        .filter(Boolean),
    );

    for (const result of results) {
      if (result.status === "rejected") {
        req.log.error("Failed to unregister installation:", result.reason);
      }
    }

    await prisma.identitiesOnDevice.delete({
      where: {
        deviceId_identityId: {
          deviceId,
          identityId,
        },
      },
    });

    res.status(204).send();
  } catch {
    res.status(500).json({ error: "Failed to unlink identity from device" });
  }
};
