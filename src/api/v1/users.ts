import { DeviceOS, PrismaClient, type Prisma } from "@prisma/client";
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

// schema for creating and updating a user
const userSchema = z.object({
  privyUserId: z.string(),
  privyAddress: z.string(),
  inboxId: z.string(),
  deviceOS: z.enum(Object.keys(DeviceOS) as [DeviceOS, ...DeviceOS[]]),
  deviceName: z.string().optional(),
});

type CreateOrUpdateUserRequestBody = z.infer<typeof userSchema>;

// POST /users - Create a new user
usersRouter.post(
  "/",
  async (
    req: Request<unknown, unknown, CreateOrUpdateUserRequestBody>,
    res: Response,
  ) => {
    try {
      const { privyUserId, deviceOS, deviceName, privyAddress, inboxId } =
        userSchema.parse(req.body);
      const userCreateInput: Prisma.UserCreateInput = {
        privyUserId,
        devices: {
          create: {
            os: deviceOS,
            name: deviceName,
            identities: {
              create: {
                identity: {
                  create: {
                    privyAddress,
                    xmtpId: inboxId,
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
      };

      const user = await prisma.user.create({
        data: userCreateInput,
      });

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

// PUT /users/:id - Update a user
usersRouter.put(
  "/:id",
  async (
    req: Request<GetUserRequestParams, unknown, CreateOrUpdateUserRequestBody>,
    res: Response,
  ) => {
    try {
      const { id } = req.params;
      const validatedData = userSchema.partial().parse(req.body);

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
