import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { prisma } from "@/utils/prisma";
import { DeviceSchema } from "../../../prisma/generated/zod";

const devicesRouter = Router();

export type GetDeviceRequestParams = {
  userId: string;
  deviceId: string;
};

// GET /devices/:userId/:deviceId - Get a single device by ID
devicesRouter.get(
  "/:userId/:deviceId",
  async (req: Request<GetDeviceRequestParams>, res: Response) => {
    try {
      const { userId, deviceId } = req.params;
      const { xmtpId } = req.app.locals;

      // First find the user to verify they exist and are the authenticated user
      const user = await prisma.user.findFirst({
        where: {
          id: userId,
          DeviceIdentity: {
            some: {
              xmtpId,
            },
          },
        },
      });

      if (!user) {
        res
          .status(403)
          .json({ error: "Not authorized to access this user's devices" });
        return;
      }

      // Now find the device
      const device = await prisma.device.findFirst({
        where: {
          id: deviceId,
          userId,
        },
      });

      if (!device) {
        res.status(404).json({ error: "Device not found" });
        return;
      }

      res.json(device);
    } catch {
      res.status(500).json({ error: "Failed to fetch device" });
    }
  },
);

export type GetDevicesRequestParams = {
  userId: string;
};

// GET /devices/:userId - Get all devices for a user
devicesRouter.get(
  "/:userId",
  async (req: Request<GetDevicesRequestParams>, res: Response) => {
    try {
      const { userId } = req.params;
      const { xmtpId } = req.app.locals;

      // First find the user to verify they exist and are the authenticated user
      const user = await prisma.user.findFirst({
        where: {
          id: userId,
          DeviceIdentity: {
            some: {
              xmtpId,
            },
          },
        },
      });

      if (!user) {
        res
          .status(403)
          .json({ error: "Not authorized to access this user's devices" });
        return;
      }

      const devices = await prisma.device.findMany({
        where: { userId },
      });

      res.json(devices);
    } catch {
      res.status(500).json({ error: "Failed to fetch devices" });
    }
  },
);

export const DeviceInputSchema = DeviceSchema.pick({
  name: true,
  os: true,
  pushToken: true,
  expoToken: true,
}).partial({
  pushToken: true,
  expoToken: true,
});

export type CreateDeviceRequestBody = z.infer<typeof DeviceInputSchema>;

export type CreateDeviceRequestParams = {
  userId: string;
};

// POST /devices/:userId - Create a new device
devicesRouter.post(
  "/:userId",
  async (
    req: Request<CreateDeviceRequestParams, unknown, CreateDeviceRequestBody>,
    res: Response,
  ) => {
    try {
      const { userId } = req.params;
      const { xmtpId } = req.app.locals;

      // First find the user to verify they exist and are the authenticated user
      const user = await prisma.user.findFirst({
        where: {
          id: userId,
          DeviceIdentity: {
            some: {
              xmtpId,
            },
          },
        },
      });

      if (!user) {
        res
          .status(403)
          .json({ error: "Not authorized to create a device for this user" });
        return;
      }

      const validatedData = DeviceInputSchema.parse(req.body);

      const device = await prisma.device.create({
        data: {
          ...validatedData,
          user: {
            connect: {
              id: userId,
            },
          },
        },
      });

      res.status(201).json(device);
    } catch (error) {
      if (error instanceof z.ZodError) {
        res
          .status(400)
          .json({ error: "Invalid request body", details: error.errors });
        return;
      }
      res.status(500).json({ error: "Failed to create device" });
    }
  },
);

export type UpdateDeviceRequestParams = {
  userId: string;
  deviceId: string;
};

const DeviceUpdateInputSchema = DeviceSchema.pick({
  name: true,
  os: true,
  pushToken: true,
  expoToken: true,
}).partial();

export type UpdateDeviceRequestBody = z.infer<typeof DeviceUpdateInputSchema>;

// PUT /devices/:userId/:deviceId - Update a device
devicesRouter.put(
  "/:userId/:deviceId",
  async (
    req: Request<UpdateDeviceRequestParams, unknown, UpdateDeviceRequestBody>,
    res: Response,
  ) => {
    try {
      const { userId, deviceId } = req.params;
      const { xmtpId } = req.app.locals;

      // First find the user to verify they exist and are the authenticated user
      const user = await prisma.user.findFirst({
        where: {
          id: userId,
          DeviceIdentity: {
            some: {
              xmtpId,
            },
          },
        },
      });

      if (!user) {
        res
          .status(403)
          .json({ error: "Not authorized to update this user's device" });
        return;
      }

      const validatedData = DeviceUpdateInputSchema.parse(req.body);

      const device = await prisma.device.update({
        where: {
          id: deviceId,
          userId,
        },
        data: validatedData,
      });

      res.json(device);
    } catch (error) {
      if (error instanceof z.ZodError) {
        res
          .status(400)
          .json({ error: "Invalid request body", details: error.errors });
        return;
      }
      res.status(500).json({ error: "Failed to update device" });
    }
  },
);

export default devicesRouter;
