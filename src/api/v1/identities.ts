import { PrismaClient } from "@prisma/client";
import { Router, type Request, type Response } from "express";
import { z } from "zod";

const identitiesRouter = Router();
const prisma = new PrismaClient();

// Schema for creating and updating a device identity
const deviceIdentitySchema = z.object({
  xmtpId: z.string().optional(),
  privyAddress: z.string(),
});

export type GetDeviceIdentitiesRequestParams = {
  deviceId: string;
};

// GET /identities/device/:deviceId - Get all identities for a device
identitiesRouter.get(
  "/device/:deviceId",
  async (req: Request<GetDeviceIdentitiesRequestParams>, res: Response) => {
    try {
      const { deviceId } = req.params;

      const deviceWithIdentities = await prisma.device.findUnique({
        where: { id: deviceId },
        include: {
          identities: {
            include: {
              identity: true,
            },
          },
        },
      });

      if (!deviceWithIdentities) {
        res.status(404).json({ error: "Device not found" });
        return;
      }

      // Transform the response to return just the identities
      const identities = deviceWithIdentities.identities.map(
        (item) => item.identity,
      );

      res.json(identities);
    } catch {
      res.status(500).json({ error: "Failed to fetch device identities" });
    }
  },
);

export type GetUserIdentitiesRequestParams = {
  userId: string;
};

// GET /identities/user/:userId - Get all identities for a user
identitiesRouter.get(
  "/user/:userId",
  async (req: Request<GetUserIdentitiesRequestParams>, res: Response) => {
    try {
      const { userId } = req.params;

      const identities = await prisma.deviceIdentity.findMany({
        where: { userId },
      });

      res.json(identities);
    } catch {
      res.status(500).json({ error: "Failed to fetch user identities" });
    }
  },
);

export type GetIdentityRequestParams = {
  identityId: string;
};

// GET /identities/:identityId - Get a single identity by ID
identitiesRouter.get(
  "/:identityId",
  async (req: Request<GetIdentityRequestParams>, res: Response) => {
    try {
      const { identityId } = req.params;
      const identity = await prisma.deviceIdentity.findUnique({
        where: { id: identityId },
      });

      if (!identity) {
        res.status(404).json({ error: "Identity not found" });
        return;
      }

      res.json(identity);
    } catch {
      res.status(500).json({ error: "Failed to fetch identity" });
    }
  },
);

export type CreateIdentityRequestBody = z.infer<typeof deviceIdentitySchema>;

export type CreateIdentityWithDeviceRequestParams = {
  deviceId: string;
};

// POST /identities/device/:deviceId - Create a new identity and associate it with a device
identitiesRouter.post(
  "/device/:deviceId",
  async (
    req: Request<
      CreateIdentityWithDeviceRequestParams,
      unknown,
      CreateIdentityRequestBody
    >,
    res: Response,
  ) => {
    try {
      const { deviceId } = req.params;
      const validatedData = deviceIdentitySchema.parse(req.body);

      const device = await prisma.device.findUnique({
        where: { id: deviceId },
        include: {
          user: true,
        },
      });

      if (!device) {
        res.status(404).json({ error: "Device not found" });
        return;
      }

      const identity = await prisma.deviceIdentity.create({
        data: {
          ...validatedData,
          userId: device.user.id,
          devices: {
            create: {
              deviceId,
            },
          },
        },
      });

      res.status(201).json(identity);
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: "Invalid request body" });
        return;
      }
      res.status(500).json({ error: "Failed to create identity" });
    }
  },
);

export type UpdateIdentityRequestParams = {
  identityId: string;
};

// PUT /identities/:identityId - Update an identity
identitiesRouter.put(
  "/:identityId",
  async (
    req: Request<
      UpdateIdentityRequestParams,
      unknown,
      CreateIdentityRequestBody
    >,
    res: Response,
  ) => {
    try {
      const { identityId } = req.params;
      const validatedData = deviceIdentitySchema.parse(req.body);

      const identity = await prisma.deviceIdentity.update({
        where: { id: identityId },
        data: validatedData,
      });

      res.json(identity);
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: "Invalid request body" });
        return;
      }
      res.status(500).json({ error: "Failed to update identity" });
    }
  },
);

export type LinkDeviceRequestParams = {
  identityId: string;
};

export type LinkDeviceRequestBody = {
  deviceId: string;
};

// POST /identities/:identityId/link - Link an existing identity to a device
identitiesRouter.post(
  "/:identityId/link",
  async (
    req: Request<LinkDeviceRequestParams, unknown, LinkDeviceRequestBody>,
    res: Response,
  ) => {
    try {
      const { identityId } = req.params;
      const { deviceId } = req.body;

      if (!deviceId) {
        res.status(400).json({ error: "deviceId is required in request body" });
        return;
      }

      const identityOnDevice = await prisma.identitiesOnDevice.create({
        data: {
          deviceId,
          identityId,
        },
      });

      res.status(201).json(identityOnDevice);
    } catch {
      res.status(500).json({ error: "Failed to link identity to device" });
    }
  },
);

export type UnlinkDeviceRequestParams = {
  identityId: string;
};

export type UnlinkDeviceRequestBody = {
  deviceId: string;
};

// DELETE /identities/:identityId/link - Unlink an identity from a device
identitiesRouter.delete(
  "/:identityId/link",
  async (
    req: Request<UnlinkDeviceRequestParams, unknown, UnlinkDeviceRequestBody>,
    res: Response,
  ) => {
    try {
      const { identityId } = req.params;
      const { deviceId } = req.body;

      if (!deviceId) {
        res.status(400).json({ error: "deviceId is required in request body" });
        return;
      }

      await prisma.identitiesOnDevice.delete({
        where: {
          deviceId_identityId: {
            deviceId,
            identityId,
          },
        },
      });

      res.status(204).send();
    } catch {
      res.status(500).json({ error: "Failed to unlink identity from device" });
    }
  },
);

export default identitiesRouter;
