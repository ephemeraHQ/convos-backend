import { DeviceOS } from "@prisma/client";
import type { Request, Response } from "express";
import { z } from "zod";
import { prisma } from "@/utils/prisma";

export const createUserRequestBodySchema = z.object({
  device: z.object({
    id: z.string(),
    os: z.enum(Object.keys(DeviceOS) as [DeviceOS, ...DeviceOS[]]),
    name: z.string().nullable().optional(),
  }),
  identity: z.object({
    identityAddress: z.string().optional(),
    xmtpId: z.string(),
    xmtpInstallationId: z.string().optional(), // TO DO remove optional once all users have fully migrated to newer version of app
  }),
  // Profile data no longer accepted as profiles have been removed
  // Keeping for backwards compatibility but will be ignored
  profile: z
    .object({
      name: z.string().min(1).optional(),
      username: z.string().min(1).optional(),
      description: z.string().nullable().optional(),
      avatar: z.string().url().nullable().optional(),
    })
    .optional(),
});

export type InitRequestBody = z.infer<typeof createUserRequestBodySchema>;

export type InitResponse = {
  device: {
    id: string;
    os: DeviceOS;
    name: string | null;
  };
  identity: {
    id: string;
    identityAddress: string | null;
    xmtpId: string | null;
  };
  profile: null; // Profiles have been removed, returning null for backwards compatibility
};

export async function init(
  req: Request<unknown, unknown, InitRequestBody>,
  res: Response,
) {
  try {
    let body;
    try {
      body = await createUserRequestBodySchema.parseAsync(req.body);
    } catch (parseError) {
      if (parseError instanceof z.ZodError) {
        req.log.error({ error: parseError }, "Invalid request body");
        res.status(400).json({
          success: false,
          message: "Invalid request body",
          errors: parseError.errors,
        });
        return;
      }
      throw parseError;
    }

    // Profile validation removed as profiles are no longer supported

    // Execute all database operations in a transaction to ensure atomicity
    const { device, deviceIdentity } = await prisma.$transaction(async (tx) => {
      // Connect or create device
      const device = await tx.device.upsert({
        where: {
          id: body.device.id,
        },
        update: {},
        create: {
          id: body.device.id,
          os: body.device.os,
          name: body.device.name,
        },
      });

      // Create device identity without profile (profiles have been removed)
      const deviceIdentity = await tx.deviceIdentity.create({
        data: {
          xmtpId: body.identity.xmtpId,
          identityAddress: body.identity.identityAddress,
        },
      });

      // Link identity to device
      await tx.identitiesOnDevice.create({
        data: {
          deviceId: device.id,
          identityId: deviceIdentity.id,
          xmtpInstallationId: body.identity.xmtpInstallationId,
        },
      });

      return { device, deviceIdentity };
    });

    const returnedUser: InitResponse = {
      device: {
        id: device.id,
        os: device.os,
        name: device.name,
      },
      identity: {
        id: deviceIdentity.id,
        identityAddress: deviceIdentity.identityAddress,
        xmtpId: deviceIdentity.xmtpId,
      },
      profile: null, // Profiles have been removed
    };

    // Namestone registration removed as profiles are no longer supported

    res.status(201).json(returnedUser);
  } catch (error) {
    req.log.error({ error }, "Error creating user");
    res.status(500).json({ error: "Failed to create user" });
  }
}
