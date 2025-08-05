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
    os: z.enum(Object.keys(DeviceOS) as [DeviceOS, ...DeviceOS[]]),
    name: z.string().nullable().optional(),
  }),
  identity: z.object({
    turnkeyAddress: z.string().optional(),
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
    turnkeyAddress: string | null;
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

    // Create user
    const createdUser = await prisma.user.create({
      data: {
        userId: body.userId,
        userType: body.userType,
        devices: {
          create: {
            os: body.device.os,
            name: body.device.name,
            identities: {
              create: {
                xmtpInstallationId: body.identity.xmtpInstallationId,
                identity: {
                  create: {
                    turnkeyAddress: body.identity.turnkeyAddress,
                    xmtpId: body.identity.xmtpId,
                    user: {
                      connect: {
                        userType_userId: {
                          userId: body.userId,
                          userType: body.userType,
                        },
                      },
                    },
                    profile: {
                      create: {
                        name: body.profile.name || null,
                        username: body.profile.username || null,
                        description: body.profile.description,
                        avatar: body.profile.avatar,
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      select: {
        id: true,
        userId: true,
        userType: true,
        devices: {
          select: {
            id: true,
            os: true,
            name: true,
            identities: {
              select: {
                identity: {
                  select: {
                    id: true,
                    turnkeyAddress: true,
                    xmtpId: true,
                    profile: {
                      select: {
                        id: true,
                        name: true,
                        username: true,
                        description: true,
                        avatar: true,
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!createdUser.devices.length) {
      throw new Error("Device was not created successfully");
    }

    const createdDevice = createdUser.devices[0];

    if (!createdDevice.identities.length) {
      throw new Error("Identity was not created successfully");
    }

    const createdIdentity = createdDevice.identities[0].identity;

    const createdProfile = createdIdentity.profile;
    if (!createdProfile) {
      throw new Error("Profile was not created successfully");
    }

    const returnedUser: CreatedReturnedUser = {
      id: createdUser.id,
      userId: createdUser.userId,
      userType: createdUser.userType,
      device: {
        id: createdDevice.id,
        os: createdDevice.os,
        name: createdDevice.name,
      },
      identity: {
        id: createdIdentity.id,
        turnkeyAddress: createdIdentity.turnkeyAddress,
        xmtpId: createdIdentity.xmtpId,
      },
      profile: {
        id: createdProfile.id,
        name: createdProfile.name,
        username: createdProfile.username,
        description: createdProfile.description,
        avatar: createdProfile.avatar,
      },
    };

    // Register the username with Namestone only if both username and turnkeyAddress are available
    if (createdIdentity.turnkeyAddress && createdProfile.username) {
      // Don't await to avoid blocking the user creation response
      namestoneService
        .setName({
          username: createdProfile.username,
          address: createdIdentity.turnkeyAddress,
          textRecords: {
            ...(createdProfile.name && { "display.name": createdProfile.name }),
            ...(createdProfile.description && {
              description: createdProfile.description,
            }),
            ...(createdProfile.avatar && { avatar: createdProfile.avatar }),
          },
        })
        .catch((namestoneError: unknown) => {
          // Log error but don't fail user creation
          req.log.error(
            {
              error: namestoneError,
              username: createdProfile.username,
              address: createdIdentity.turnkeyAddress,
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
