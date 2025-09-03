import { type Request, type Response } from "express";
import { prisma } from "@/utils/prisma";

export async function listDevicesHandler(req: Request, res: Response) {
  try {
    const { xmtpId } = req.app.locals;

    // Verify authenticated identity exists
    const identity = await prisma.deviceIdentity.findFirst({
      where: { xmtpId },
      select: { id: true },
    });

    if (!identity) {
      res
        .status(403)
        .json({ error: "Not authorized to access this user's devices" });
      return;
    }

    // Get all devices associated with this user
    const devices = await prisma.device.findMany({
      where: {
        identities: { some: { identityId: identity.id } },
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
