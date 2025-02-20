import { DeviceOS, PrismaClient } from "@prisma/client";
import type { Request, Response } from "express";
import { z } from "zod";
import { validateProfile } from "../../profiles/profile.validation";
import type { CreatedReturnedUser } from "../users.types";

const prisma = new PrismaClient();

export const userCreateSchema = z.object({
  privyUserId: z.string(),
  device: z.object({
    os: z.enum(Object.keys(DeviceOS) as [DeviceOS, ...DeviceOS[]]),
    name: z.string().optional(),
  }),
  identity: z.object({
    privyAddress: z.string(),
    xmtpId: z.string(),
  }),
  profile: z
    .object({
      name: z.string(),
      description: z.string().optional(),
      avatar: z.string().url().optional(),
    })
    .optional(),
});

export type CreateUserRequestBody = z.infer<typeof userCreateSchema>;

export async function createUser(
  req: Request<unknown, unknown, CreateUserRequestBody>,
  res: Response,
) {
  try {
    const {
      privyUserId,
      device,
      identity: { privyAddress, xmtpId },
      profile,
    } = userCreateSchema.parse(req.body);

    if (profile) {
      const validationResult = await validateProfile({
        name: profile.name,
        description: profile.description,
      });
      if (!validationResult.success) {
        res.status(400).json(validationResult);
        return;
      }
    }

    const createdUser = await prisma.user.create({
      data: {
        privyUserId,
        devices: {
          create: {
            os: device.os,
            name: device.name,
            identities: {
              create: {
                identity: {
                  create: {
                    privyAddress,
                    xmtpId,
                    user: {
                      connect: {
                        privyUserId,
                      },
                    },
                    profile: profile
                      ? {
                          create: {
                            name: profile.name,
                            description: profile.description,
                            avatar: profile.avatar,
                          },
                        }
                      : undefined,
                  },
                },
              },
            },
          },
        },
      },
      include: {
        devices: {
          include: {
            identities: {
              include: {
                identity: {
                  include: {
                    profile: true,
                  },
                },
              },
            },
          },
        },
      },
    });

    const {
      id,
      devices: [
        {
          id: deviceId,
          os: deviceOs,
          name: deviceName,
          identities: [{ identity }],
        },
      ],
    } = createdUser;

    const returnedUser: CreatedReturnedUser = {
      id,
      privyUserId,
      device: {
        id: deviceId,
        os: deviceOs,
        name: deviceName,
      },
      identity: {
        id: identity.id,
        privyAddress: identity.privyAddress,
        xmtpId: identity.xmtpId,
      },
      profile: identity.profile
        ? {
            id: identity.profile.id,
            name: identity.profile.name,
            description: identity.profile.description,
          }
        : null,
    };

    res.status(201).json(returnedUser);
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Invalid request body" });
      return;
    }
    res.status(500).json({ error: "Failed to create user" });
  }
}
