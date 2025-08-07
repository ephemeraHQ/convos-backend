import { DeviceOS, type UserType } from "@prisma/client";
import type { Request, Response } from "express";
import { z } from "zod";
import { prisma } from "@/utils/prisma";
import { UserTypeSchema } from "../../../../../prisma/generated/zod";
import { namestoneService } from "../../../../utils/namestone";
import {
  validateOnChainName,
  validateUsernameUniqueness,
} from "../../profiles/handlers/validate-profile";

export const createUserRequestBodySchema = z.object({
  userId: z.string(),
  userType: UserTypeSchema,
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
  profile: z.object({
    name: z.string().min(1).optional(),
    username: z.string().min(1).optional(),
    description: z.string().nullable().optional(),
    avatar: z.string().url().nullable().optional(),
  }),
});

export type CreateUserRequestBody = z.infer<typeof createUserRequestBodySchema>;

export type CreatedReturnedUser = {
  id: string;
  userId: string;
  userType: UserType;
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
  profile: {
    id: string;
    name: string | null;
    username: string | null;
    description: string | null;
    avatar: string | null;
  };
};

export async function createUser(
  req: Request<unknown, unknown, CreateUserRequestBody>,
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

    // Validate username uniqueness only if username is provided
    if (body.profile.username?.trim()) {
      const uniquenessResult = await validateUsernameUniqueness(
        body.profile.username,
      );
      if (!uniquenessResult.success) {
        res.status(400).json(uniquenessResult);
        return;
      }
    }

    // If name contains a dot, validate on-chain name ownership
    if (body.profile.name && body.profile.name.includes(".")) {
      const onChainResult = await validateOnChainName({
        name: body.profile.name,
        xmtpId: body.identity.xmtpId,
      });
      if (!onChainResult.success) {
        res.status(400).json(onChainResult);
        return;
      }
    }

    // Create user first
    const createdUser = await prisma.user.create({
      data: {
        userId: body.userId,
        userType: body.userType,
      },
    });

    // Connect or create device
    const device = await prisma.device.upsert({
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

    // Connect user to device
    await prisma.usersOnDevice.upsert({
      where: {
        userId_deviceId: {
          userId: createdUser.id,
          deviceId: device.id,
        },
      },
      update: {},
      create: {
        userId: createdUser.id,
        deviceId: device.id,
      },
    });

    // Create device identity
    const deviceIdentity = await prisma.deviceIdentity.create({
      data: {
        userId: createdUser.id,
        xmtpId: body.identity.xmtpId,
        identityAddress: body.identity.identityAddress,
        profile: {
          create: {
            name: body.profile.name || null,
            username: body.profile.username || null,
            description: body.profile.description,
            avatar: body.profile.avatar,
          },
        },
      },
      include: {
        profile: true,
      },
    });

    // Link identity to device
    await prisma.identitiesOnDevice.create({
      data: {
        deviceId: device.id,
        identityId: deviceIdentity.id,
        xmtpInstallationId: body.identity.xmtpInstallationId,
      },
    });

    if (!deviceIdentity.profile) {
      throw new Error("Profile was not created successfully");
    }

    const returnedUser: CreatedReturnedUser = {
      id: createdUser.id,
      userId: createdUser.userId,
      userType: createdUser.userType,
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
      profile: {
        id: deviceIdentity.profile.id,
        name: deviceIdentity.profile.name,
        username: deviceIdentity.profile.username,
        description: deviceIdentity.profile.description,
        avatar: deviceIdentity.profile.avatar,
      },
    };

    // Register the username with Namestone only if both username and identityAddress are available
    if (deviceIdentity.identityAddress && deviceIdentity.profile.username) {
      // Don't await to avoid blocking the user creation response
      namestoneService
        .setName({
          username: deviceIdentity.profile.username,
          address: deviceIdentity.identityAddress,
          textRecords: {
            ...(deviceIdentity.profile.name && {
              "display.name": deviceIdentity.profile.name,
            }),
            ...(deviceIdentity.profile.description && {
              description: deviceIdentity.profile.description,
            }),
            ...(deviceIdentity.profile.avatar && {
              avatar: deviceIdentity.profile.avatar,
            }),
          },
        })
        .catch((namestoneError: unknown) => {
          // Log error but don't fail user creation
          req.log.error(
            {
              error: namestoneError,
              username: deviceIdentity.profile?.username,
              address: deviceIdentity.identityAddress,
            },
            "Failed to register username with Namestone during user creation",
          );
        });
    }

    res.status(201).json(returnedUser);
  } catch (error) {
    console.error("Error creating user:", error);
    res.status(500).json({ error: "Failed to create user" });
  }
}
