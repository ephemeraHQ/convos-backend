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

    const authenticatedUser = await prisma.deviceIdentity.findFirstOrThrow({
      where: { xmtpId: authenticatedXmtpId },
    });

    const { xmtpInstallationId } = unregisterRequestParamsSchema.parse(
      req.params,
    );

    const identityOnDevice = await prisma.identitiesOnDevice.findUnique({
      where: {
        xmtpInstallationId: xmtpInstallationId,
      },
      include: {
        device: { select: { userId: true } },
      },
    });

    if (!identityOnDevice) {
      return res.status(404).json({ error: "Installation not found" });
    }

    // Verify that the installation belongs to the authenticated user
    if (identityOnDevice.device.userId !== authenticatedUser.id) {
      req.log.warn(
        `User ${authenticatedUser.id} attempt to unregister unowned installation ${xmtpInstallationId}`,
      );
      return res
        .status(403)
        .json({ error: "Forbidden: Installation access denied" });
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
      return res.status(400).json({ errors: error.errors });
    }
    req.log.error({ error }, "Failed to unregister installation");
    res.status(500).json({ error: "Failed to delete installation" });
  }
}
