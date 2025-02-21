import { DeviceOS, PrismaClient } from "@prisma/client";
import type { Request, Response } from "express";
import { z } from "zod";
import { ValidationError } from "../../../../utils/errors";
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
    description: string | null;
  };
};

export async function createUser(
  req: Request<unknown, unknown, CreateUserRequestBody>,
  res: Response,
) {
  let parsedBody: CreateUserRequestBody;

  try {
    parsedBody = createUserRequestBodySchema.parse(req.body);
  } catch (error) {
    throw new ValidationError(
      "Invalid request body",
      error instanceof z.ZodError ? error.errors : undefined,
    );
  }

  const validationResult = await validateProfile({
    name: parsedBody.profile.name,
    description: parsedBody.profile.description,
  });

  if (!validationResult.success) {
    throw new ValidationError("Invalid profile data", validationResult);
  }

  const createdUser = await prisma.user.create({
    data: {
      privyUserId: parsedBody.privyUserId,
      devices: {
        create: {
          os: parsedBody.device.os,
          name: parsedBody.device.name,
          identities: {
            create: {
              identity: {
                create: {
                  privyAddress: parsedBody.identity.privyAddress,
                  xmtpId: parsedBody.identity.xmtpId,
                  user: {
                    connect: {
                      privyUserId: parsedBody.privyUserId,
                    },
                  },
                  profile: {
                    create: {
                      name: parsedBody.profile.name,
                      username: parsedBody.profile.username,
                      description: parsedBody.profile.description,
                      avatar: parsedBody.profile.avatar,
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
      description: createdProfile.description,
    },
  };

  res.status(201).json(returnedUser);
}
