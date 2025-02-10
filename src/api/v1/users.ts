import { DeviceOS, PrismaClient } from "@prisma/client";
import { Router, type Request, type Response } from "express";
import { z } from "zod";

const usersRouter = Router();
const prisma = new PrismaClient();

type GetUserRequestParams = {
  id: string;
};

// GET /users/:id - Get a single user by ID
usersRouter.get(
  "/:id",
  async (req: Request<GetUserRequestParams>, res: Response) => {
    try {
      const { id } = req.params;
      const user = await prisma.user.findUnique({
        where: { id },
      });

      if (!user) {
        res.status(404).json({ error: "User not found" });
        return;
      }

      res.json(user);
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "Failed to fetch user" });
    }
  },
);

// schema for creating a user
const userCreateSchema = z.object({
  privyUserId: z.string(),
  device: z.object({
    os: z.enum(Object.keys(DeviceOS) as [DeviceOS, ...DeviceOS[]]),
    name: z.string().optional(),
  }),
  identity: z.object({
    privyAddress: z.string(),
    xmtpId: z.string(),
  }),
});

type CreateUserRequestBody = z.infer<typeof userCreateSchema>;

export type CreatedUser = {
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
    xmtpId: string;
  };
};

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
                  identity: true,
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
            os,
            name,
            identities: [
              {
                identity: { id: identityId },
              },
            ],
          },
        ],
      } = createdUser;
      // format user data for response
      const user = {
        id,
        privyUserId,
        device: {
          id: deviceId,
          os,
          name,
        },
        identity: {
          id: identityId,
          privyAddress,
          xmtpId,
        },
      } satisfies CreatedUser;

      res.status(201).json(user);
    } catch (error) {
      console.error(error);
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

// PUT /users/:id - Update a user
usersRouter.put(
  "/:id",
  async (
    req: Request<GetUserRequestParams, unknown, UpdateUserRequestBody>,
    res: Response,
  ) => {
    try {
      const { id } = req.params;
      const validatedData = userUpdateSchema.partial().parse(req.body);

      const user = await prisma.user.update({
        where: { id },
        data: validatedData,
      });

      res.json(user);
    } catch (error) {
      console.error(error);
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: "Invalid request body" });
        return;
      }
      res.status(500).json({ error: "Failed to update user" });
    }
  },
);

export default usersRouter;
