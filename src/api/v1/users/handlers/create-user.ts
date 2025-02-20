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

  const {
    privyUserId,
    device,
    identity: { privyAddress, xmtpId },
    profile,
  } = parsedBody;

  const validationResult = await validateProfile({
    name: profile.name,
    description: profile.description,
  });

  if (!validationResult.success) {
    throw new ValidationError("Invalid profile data", validationResult);
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
                  profile: {
                    create: {
                      name: profile.name,
                      description: profile.description,
                      avatar: profile.avatar,
                    },
                  },
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
    profile: {
      id: identity.profile!.id,
      name: identity.profile!.name,
      description: identity.profile!.description,
    },
  };

  res.status(201).json(returnedUser);
}
