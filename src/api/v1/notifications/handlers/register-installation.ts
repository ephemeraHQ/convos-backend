import type { Request, Response } from "express";
import { z } from "zod";
import { createNotificationClient } from "@/notifications/client";
import { prisma } from "@/utils/prisma";

const registrationSchema = z.object({
  deviceId: z.string(),
  identityId: z.string(),
  xmtpInstallationId: z.string(),
  expoToken: z.string(),
  pushToken: z.string(),
});

type RegisterInstallationRequestBody = z.infer<typeof registrationSchema>;

const notificationClient = createNotificationClient();

export async function registerInstallation(
  req: Request<unknown, unknown, RegisterInstallationRequestBody>,
  res: Response,
) {
  try {
    const authenticatedXmtpId = req.app.locals.xmtpId;

    const validatedData = registrationSchema.parse(req.body);

    const [
      deviceIdentityForAuthenticatedUser,
      deviceOwnerCheck,
      identityOwnerCheck,
    ] = await Promise.all([
      prisma.deviceIdentity.findFirstOrThrow({
        where: { xmtpId: authenticatedXmtpId },
        select: { userId: true },
      }),
      prisma.device.findUnique({
        where: { id: validatedData.deviceId },
        select: { userId: true },
      }),
      prisma.deviceIdentity.findUnique({
        where: { id: validatedData.identityId },
        select: { userId: true },
      }),
    ]);

    // Check device ownership
    if (
      !deviceOwnerCheck ||
      deviceOwnerCheck.userId !== deviceIdentityForAuthenticatedUser.userId
    ) {
      req.log.warn(
        `User ${deviceIdentityForAuthenticatedUser.userId} attempt to register for unowned/unknown device ${validatedData.deviceId}`,
      );
      return res.status(403).json({ error: "Forbidden: Device access denied" });
    }

    // Check identity ownership
    if (
      !identityOwnerCheck ||
      identityOwnerCheck.userId !== deviceIdentityForAuthenticatedUser.userId
    ) {
      req.log.warn(
        `User ${deviceIdentityForAuthenticatedUser.userId} attempt to register for unowned/unknown identity ${validatedData.identityId}`,
      );
      return res
        .status(403)
        .json({ error: "Forbidden: Identity access denied" });
    }

    await prisma.$transaction([
      // 1. Update Device the device push tokens
      prisma.device.update({
        where: {
          id: validatedData.deviceId,
        },
        data: {
          expoToken: validatedData.expoToken,
          pushToken: validatedData.pushToken,
        },
      }),
      // 2. Update IdentitiesOnDevice with the xmtpInstallationId
      prisma.identitiesOnDevice.upsert({
        where: {
          deviceId_identityId: {
            deviceId: validatedData.deviceId,
            identityId: validatedData.identityId,
          },
        },
        create: {
          deviceId: validatedData.deviceId,
          identityId: validatedData.identityId,
          xmtpInstallationId: validatedData.xmtpInstallationId,
        },
        update: {
          xmtpInstallationId: validatedData.xmtpInstallationId,
        },
      }),
    ]);

    // 3. Register with the XMTP notification server
    const response = await notificationClient.registerInstallation({
      installationId: validatedData.xmtpInstallationId,
      deliveryMechanism: {
        deliveryMechanismType: {
          case: "customToken",
          value: validatedData.expoToken,
        },
      },
    });

    res.status(201).json({
      installationId: response.installationId,
      validUntil: Number(response.validUntil),
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ errors: error.errors });
    }
    req.log.error({ error }, "Failed to register installation");
    res.status(500).json({ error: "Failed to register installation" });
  }
}
