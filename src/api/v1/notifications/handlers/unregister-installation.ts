import type { Request, Response } from "express";
import { z } from "zod";
import { createNotificationClient } from "@/notifications/client";
import { prisma } from "@/utils/prisma";

// Schema for unregistration
const unregisterRequestParamsSchema = z.object({
  xmtpInstallationId: z.string(),
});

type UnregisterRequestParams = z.infer<typeof unregisterRequestParamsSchema>;

const notificationClient = createNotificationClient();

export async function unregisterInstallation(
  req: Request<UnregisterRequestParams>,
  res: Response,
) {
  try {
    const authenticatedXmtpId = req.app.locals.xmtpId;

    const { xmtpInstallationId } = unregisterRequestParamsSchema.parse(
      req.params,
    );

    const [deviceIdentityForUser, identityOnDeviceForInstallation] =
      await Promise.all([
        prisma.deviceIdentity.findFirstOrThrow({
          where: { xmtpId: authenticatedXmtpId },
          select: { userId: true },
        }),
        prisma.identitiesOnDevice.findUnique({
          where: {
            xmtpInstallationId: xmtpInstallationId,
          },
          include: {
            device: { select: { userId: true } },
          },
        }),
      ]);

    if (!identityOnDeviceForInstallation) {
      req.log.warn(
        `Installation ${xmtpInstallationId} not found for user ${authenticatedXmtpId}`,
      );
      res.status(404).json({ error: "Installation not found" });
      return;
    }

    // Verify that the installation belongs to the authenticated user
    if (
      identityOnDeviceForInstallation.device.userId !==
      deviceIdentityForUser.userId
    ) {
      req.log.warn(
        `User ${deviceIdentityForUser.userId} attempt to unregister unowned installation ${xmtpInstallationId}`,
      );
      res.status(403).json({ error: "Forbidden: Installation access denied" });
      return;
    }

    // 1. Nullify xmtpInstallationId in our DB
    await prisma.$transaction([
      prisma.identitiesOnDevice.update({
        where: {
          xmtpInstallationId: xmtpInstallationId,
        },
        data: {
          xmtpInstallationId: null,
        },
      }),
    ]);

    // 2. Delete from XMTP notification server
    await notificationClient.deleteInstallation({
      installationId: xmtpInstallationId,
    });

    res.status(200).send("Installation unregistered successfully");
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ errors: error.errors });
      return;
    }
    req.log.error({ error }, "Failed to unregister installation");
    res.status(500).json({ error: "Failed to delete installation" });
  }
}
