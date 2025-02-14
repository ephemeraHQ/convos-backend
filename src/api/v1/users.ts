import { DeviceOS, PrismaClient } from "@prisma/client";
import { Router, type Request, type Response } from "express";
import { z } from "zod";

const usersRouter = Router();
const prisma = new PrismaClient();

export type ReturnedUser = {
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

type GetUserRequestParams = {
  privyUserId: string;
};

// GET /users/:privyUserId - Get a single user by Privy user ID
usersRouter.get(
  "/:privyUserId",
  async (req: Request<GetUserRequestParams>, res: Response) => {
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

      // format user data for response
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
      const returnedUser = {
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
      } satisfies ReturnedUser;

      res.json(returnedUser);
    } catch {
      res.status(500).json({ error: "Failed to fetch user" });
    }
  },
);

// schema for creating a user
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

// POST /users - Create a new user
usersRouter.post(
  "/",
  async (
    req: Request<unknown, unknown, CreateUserRequestBody>,
    res: Response,
  ) => {
    try {
      const {
        privyUserId,
        device,
        identity: { privyAddress, xmtpId },
        profile,
      } = userCreateSchema.parse(req.body);

      // create new user
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

      // format user data for response
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
      const returnedUser = {
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
      } satisfies ReturnedUser;

      res.status(201).json(returnedUser);
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: "Invalid request body" });
        return;
      }
      res.status(500).json({ error: "Failed to create user" });
    }
  },
);

// schema for updating a user
const userUpdateSchema = z.object({
  privyUserId: z.string(),
});

type UpdateUserRequestBody = z.infer<typeof userUpdateSchema>;

// PUT /users/:privyUserId - Update a user by Privy user ID
usersRouter.put(
  "/:privyUserId",
  async (
    req: Request<GetUserRequestParams, unknown, UpdateUserRequestBody>,
    res: Response,
  ) => {
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
  },
);

export default usersRouter;
