import { DeviceOS, PrismaClient, type DeviceIdentity } from "@prisma/client";
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { validateProfile } from "./profiles/profile.validation";

const usersRouter = Router();
const prisma = new PrismaClient();

// Define routes after the handlers are declared
usersRouter.get("/me", getCurrentUser);
usersRouter.get("/:privyUserId", getUser);
usersRouter.post("/", createUser);
usersRouter.put("/:privyUserId", updateUser);

// getCurrentUser types and schemas
export type ReturnedCurrentUser = {
  id: string;
  identities: Array<Pick<DeviceIdentity, "id" | "privyAddress" | "xmtpId">>;
};

async function getCurrentUser(req: Request, res: Response) {
  try {
    const user = await prisma.user.findFirst({
      where: {
        DeviceIdentity: {
          some: {
            // @ts-expect-error
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
            xmtpId: req.xmtpId,
          },
        },
      },
      select: {
        id: true,
        devices: {
          select: {
            identities: {
              select: {
                identity: {
                  select: {
                    id: true,
                    privyAddress: true,
                    xmtpId: true,
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const returnedUser: ReturnedCurrentUser = {
      id: user.id,
      identities: user.devices.flatMap((device) =>
        device.identities.map(({ identity }) => ({
          id: identity.id,
          privyAddress: identity.privyAddress,
          xmtpId: identity.xmtpId,
        })),
      ),
    };

    res.json(returnedUser);
  } catch (err) {
    console.error("Error fetching current user:", err);
    res.status(500).json({ error: "Failed to fetch user" });
  }
}

type GetUserRequestParams = {
  privyUserId: string;
};

async function getUser(req: Request<GetUserRequestParams>, res: Response) {
  try {
    const { privyUserId } = req.params;
    const user = await prisma.user.findUnique({
      where: { privyUserId },
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

    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

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
    } = user;

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

    res.json(returnedUser);
  } catch (err) {
    console.error("Error fetching user:", err);
    res.status(500).json({ error: "Failed to fetch user" });
  }
}

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
  } | null;
};

// createUser types and schemas
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
    })
    .optional(),
});

export type CreateUserRequestBody = z.infer<typeof userCreateSchema>;

async function createUser(
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

// updateUser types and schemas
const userUpdateSchema = z.object({
  privyUserId: z.string(),
});
type UpdateUserRequestBody = z.infer<typeof userUpdateSchema>;

async function updateUser(
  req: Request<GetUserRequestParams, unknown, UpdateUserRequestBody>,
  res: Response,
) {
  try {
    const { privyUserId } = req.params;
    const validatedData = userUpdateSchema.partial().parse(req.body);

    const user = await prisma.user.update({
      where: { privyUserId },
      data: validatedData,
    });

    res.json(user);
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Invalid request body" });
      return;
    }
    res.status(500).json({ error: "Failed to update user" });
  }
}

export default usersRouter;
