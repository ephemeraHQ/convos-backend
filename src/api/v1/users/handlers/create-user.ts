import { DeviceOS } from "@prisma/client";
import type { Request, Response } from "express";
import { z } from "zod";
import { prisma } from "@/utils/prisma";
import {
  validateOnChainName,
  validateProfileRequiredFields,
  validateProfileSchema,
  validateUsernameUniqueness,
} from "../../profiles/handlers/validate-profile";
import { namestoneService } from "../../../../utils/namestone";

export const createUserRequestBodySchema = z.object({
  turnkeyUserId: z.string(),
  device: z.object({
    os: z.enum(Object.keys(DeviceOS) as [DeviceOS, ...DeviceOS[]]),
    name: z.string().nullable().optional(),
  }),
  identity: z.object({
    turnkeyAddress: z.string(),
    xmtpId: z.string(),
    xmtpInstallationId: z.string().optional(), // TO DO remove optional once all users have fully migrated to newer version of app
  }),
  profile: z.object({
    name: z.string(),
    username: z.string(),
    description: z.string().nullable().optional(),
    avatar: z.string().url().nullable().optional(),
  }),
});

export type CreateUserRequestBody = z.infer<typeof createUserRequestBodySchema>;

export type CreatedReturnedUser = {
  id: string;
  turnkeyUserId: string;
  device: {
    id: string;
    os: DeviceOS;
    name: string | null;
  };
  identity: {
    id: string;
    turnkeyAddress: string;
    xmtpId: string | null;
  };
  profile: {
    id: string;
    name: string;
    username: string;
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
    } catch (error) {
      if (error instanceof z.ZodError) {
        req.log.error({ error }, "Invalid request body");
        res.status(400).json({
          success: false,
          errors: {
            name:
              error.errors.find((e) => e.path.join(".") === "profile.name")
                ?.message || "Name is required",
            username:
              error.errors.find((e) => e.path.join(".") === "profile.username")
                ?.message || "Username is required",
          },
        });
        return;
      }
      throw error;
    }

    // Validate required fields
    const requiredFieldsResult = validateProfileRequiredFields(body.profile);
    if (!requiredFieldsResult.success) {
      res.status(400).json(requiredFieldsResult);
      return;
    }

    // Validate profile schema
    const schemaResult = validateProfileSchema(body.profile);
    if (!schemaResult.success) {
      res.status(400).json(schemaResult);
      return;
    }

    // Validate username uniqueness
    const uniquenessResult = await validateUsernameUniqueness(
      body.profile.username,
    );
    if (!uniquenessResult.success) {
      res.status(400).json(uniquenessResult);
      return;
    }

    // If name contains a dot, validate on-chain name ownership
    if (body.profile.name.includes(".")) {
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
        turnkeyUserId: body.turnkeyUserId,
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
                        turnkeyUserId: body.turnkeyUserId,
                      },
                    },
                    profile: {
                      create: {
                        name: body.profile.name,
                        username: body.profile.username,
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
        turnkeyUserId: true,
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
      turnkeyUserId: createdUser.turnkeyUserId,
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

    // Register the username with Namestone
    // Don't await to avoid blocking the user creation response
    namestoneService.setName({
      username: createdProfile.username,
      address: createdIdentity.turnkeyAddress,
      textRecords: {
        "display.name": createdProfile.name,
        ...(createdProfile.description && { "description": createdProfile.description }),
        ...(createdProfile.avatar && { "avatar": createdProfile.avatar }),
      },
    }).catch((error) => {
      // Log error but don't fail user creation
      req.log.error(
        { error, username: createdProfile.username, address: createdIdentity.turnkeyAddress },
        "Failed to register username with Namestone during user creation"
      );
    });

    res.status(201).json(returnedUser);
  } catch (error) {
    console.error("Error creating user:", error);
    res.status(500).json({ error: "Failed to create user" });
  }
}
