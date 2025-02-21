import { DeviceOS, PrismaClient } from "@prisma/client";
import type { Request, Response } from "express";
import { z } from "zod";
import { validateProfile } from "../../profiles/profile.validation";

const prisma = new PrismaClient();

export const createUserRequestBodySchema = z.object({
  privyUserId: z.string(),
  device: z.object({
    os: z.enum(Object.keys(DeviceOS) as [DeviceOS, ...DeviceOS[]]),
    name: z.string().optional(),
  }),
  identity: z.object({
    privyAddress: z.string(),
    xmtpId: z.string(),
  }),
  profile: z.object({
    name: z.string(),
    username: z.string(),
    description: z.string().optional(),
    avatar: z.string().url().optional(),
  }),
});

export type CreateUserRequestBody = z.infer<typeof createUserRequestBodySchema>;

export type CreatedReturnedUser = {
  id: string;
  privyUserId: string;
  device: {
    id: string;
    os: DeviceOS;
    name: string | null;
  };
  identity: {
    id: string;
    privyAddress: string;
    xmtpId: string | null;
  };
  profile: {
    id: string;
    name: string;
    username: string;
    description: string | null;
  };
};

export async function createUser(
  req: Request<object, object, CreateUserRequestBody>,
  res: Response,
): Promise<void> {
  try {
    let body;
    try {
      body = await createUserRequestBodySchema.parseAsync(req.body);
    } catch (error) {
      if (error instanceof z.ZodError) {
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

    const validationResult = await validateProfile(body.profile, false);
    if (!validationResult.success) {
      res.status(400).json({
        success: false,
        errors: validationResult.errors,
      });
      return;
    }

    // Create user
    const createdUser = await prisma.user.create({
      data: {
        privyUserId: body.privyUserId,
        devices: {
          create: {
            os: body.device.os,
            name: body.device.name,
            identities: {
              create: {
                identity: {
                  create: {
                    privyAddress: body.identity.privyAddress,
                    xmtpId: body.identity.xmtpId,
                    user: {
                      connect: {
                        privyUserId: body.privyUserId,
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
        privyUserId: true,
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
                    privyAddress: true,
                    xmtpId: true,
                    profile: {
                      select: {
                        id: true,
                        name: true,
                        username: true,
                        description: true,
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
      privyUserId: createdUser.privyUserId,
      device: {
        id: createdDevice.id,
        os: createdDevice.os,
        name: createdDevice.name,
      },
      identity: {
        id: createdIdentity.id,
        privyAddress: createdIdentity.privyAddress,
        xmtpId: createdIdentity.xmtpId,
      },
      profile: {
        id: createdProfile.id,
        name: createdProfile.name,
        username: createdProfile.username,
        description: createdProfile.description,
      },
    };

    res.status(201).json(returnedUser);
  } catch (error) {
    console.error("Error creating user:", error);
    res.status(500).json({ error: "Failed to create user" });
  }
}
