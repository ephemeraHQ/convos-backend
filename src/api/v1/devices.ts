import { DeviceOS, PrismaClient } from "@prisma/client";
import { Router, type Request, type Response } from "express";
import { z } from "zod";

const devicesRouter = Router();
const prisma = new PrismaClient();

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
      const devices = await prisma.device.findMany({
        where: { userId },
      });

      res.json(devices);
    } catch {
      res.status(500).json({ error: "Failed to fetch devices" });
    }
  },
);

// schema for creating and updating a device
const deviceSchema = z.object({
  name: z.string().optional(),
  os: z.enum(Object.keys(DeviceOS) as [DeviceOS, ...DeviceOS[]]),
  pushToken: z.string().optional(),
  expoToken: z.string().optional(),
});

export type CreateOrUpdateDeviceRequestBody = z.infer<typeof deviceSchema>;

export type CreateDeviceRequestParams = {
  userId: string;
};

// POST /devices/:userId - Create a new device
devicesRouter.post(
  "/:userId",
  async (
    req: Request<
      CreateDeviceRequestParams,
      unknown,
      CreateOrUpdateDeviceRequestBody
    >,
    res: Response,
  ) => {
    try {
      const { userId } = req.params;
      const validatedData = deviceSchema.parse(req.body);

      const device = await prisma.device.create({
        data: {
          ...validatedData,
          userId,
        },
      });

      res.status(201).json(device);
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: "Invalid request body" });
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

// PUT /devices/:userId/:deviceId - Update a device
devicesRouter.put(
  "/:userId/:deviceId",
  async (
    req: Request<
      UpdateDeviceRequestParams,
      unknown,
      CreateOrUpdateDeviceRequestBody
    >,
    res: Response,
  ) => {
    try {
      const { userId, deviceId } = req.params;
      const validatedData = deviceSchema.parse(req.body);

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
        res.status(400).json({ error: "Invalid request body" });
        return;
      }
      res.status(500).json({ error: "Failed to update device" });
    }
  },
);

export default devicesRouter;
