import { type Request, type Response } from "express";
import { z } from "zod";
import { prisma } from "@/utils/prisma";
import { DeviceSchema } from "../../../../../prisma/generated/zod";

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

export async function createDeviceHandler(
  req: Request<CreateDeviceRequestParams, unknown, CreateDeviceRequestBody>,
  res: Response,
) {
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
}
