import { type Request, type Response } from "express";
import { z } from "zod";
import { prisma } from "@/utils/prisma";

// Schema for creating and updating a device identity
const deviceIdentitySchema = z.object({
  xmtpId: z.string().optional(),
  turnkeyAddress: z.string(),
});

export type CreateIdentityRequestBody = z.infer<typeof deviceIdentitySchema>;

export type CreateIdentityWithDeviceRequestParams = {
  deviceId: string;
};

// POST /identities/device/:deviceId - Create a new identity and associate it with a device
export const createIdentityWithDevice = async (
  req: Request<
    CreateIdentityWithDeviceRequestParams,
    unknown,
    CreateIdentityRequestBody
  >,
  res: Response,
) => {
  try {
    const { deviceId } = req.params;
    const { xmtpId, xmtpInstallationId } = req.app.locals;
    const validatedData = deviceIdentitySchema.parse(req.body);

    const device = await prisma.device.findUnique({
      where: { id: deviceId },
      select: {
        user: {
          select: {
            id: true,
          },
        },
      },
    });

    if (!device) {
      res.status(404).json({ error: "Device not found" });
      return;
    }

    const deviceOwnerUserId = device.user.id;

    // Upsert the DeviceIdentity
    const identity = await prisma.deviceIdentity.upsert({
      where: {
        userId_xmtpId: {
          userId: deviceOwnerUserId,
          xmtpId: xmtpId,
        },
      },
      create: {
        userId: deviceOwnerUserId,
        xmtpId: xmtpId,
        turnkeyAddress: validatedData.turnkeyAddress,
      },
      update: {
        turnkeyAddress: validatedData.turnkeyAddress,
      },
    });

    // Link the DeviceIdentity to the Device (if not already linked)
    await prisma.identitiesOnDevice.upsert({
      where: {
        deviceId_identityId: {
          deviceId: deviceId,
          identityId: identity.id,
        },
      },
      create: {
        deviceId: deviceId,
        identityId: identity.id,
        xmtpInstallationId: xmtpInstallationId,
      },
      update: {
        xmtpInstallationId: xmtpInstallationId,
      },
    });

    // Return the created or updated identity.
    // HTTP 201 is generally used for successful creation or upsert resulting in creation/update.
    res.status(201).json(identity);
    return;
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Invalid request body" });
      return;
    }
    // Log the actual error for server-side debugging
    console.error("Failed to create/associate identity with device:", error);
    res.status(500).json({ error: "Failed to process request" });
    return;
  }
};
