import { type Request, type Response } from "express";
import { z } from "zod";
import { prisma } from "@/utils/prisma";
import { DeviceSchema } from "../../../../../prisma/generated/zod";
import { logError } from "@/utils/errors";

export type UpdateDeviceRequestParams = {
  userId: string;
  deviceId: string;
};

const DeviceUpdateInputSchema = DeviceSchema.pick({
  name: true,
  os: true,
  pushToken: true,
  pushTokenType: true,
  apnsEnv: true,
  appVersion: true,
  appBuildNumber: true,
}).partial();

export type UpdateDeviceRequestBody = z.infer<typeof DeviceUpdateInputSchema>;

export async function updateDeviceHandler(
  req: Request<UpdateDeviceRequestParams, unknown, UpdateDeviceRequestBody>,
  res: Response,
) {
  try {
    const { userId, deviceId } = req.params;
    const { xmtpId } = req.app.locals;

    // First find the user to verify they exist and are the authenticated user
    const user = await prisma.user.findFirst({
      where: {
        userId: userId,
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

    // Atomic update with ownership check to prevent race conditions
    const updateResult = await prisma.device.updateMany({
      where: {
        id: deviceId,
        users: {
          some: {
            userId: user.id,
          },
        },
      },
      data: {
        ...validatedData,
        updatedAt: new Date(),
        ...((validatedData.pushToken ||
          validatedData.pushTokenType ||
          validatedData.apnsEnv) && { pushFailures: 0 }),
      },
    });

    if (updateResult.count === 0) {
      logError(new Error("Device access attempt failed"), {
        userId,
        deviceId,
        xmtpId,
        reason: "Device not found or not associated with user",
      });
      res
        .status(404)
        .json({ error: "Device not found or not associated with this user" });
      return;
    }

    // Re-fetch the updated device to return to client
    const device = await prisma.device.findUnique({
      where: {
        id: deviceId,
      },
      select: {
        id: true,
        name: true,
        os: true,
        pushToken: true,
        pushTokenType: true,
        apnsEnv: true,
        appVersion: true,
        appBuildNumber: true,
        createdAt: true,
        updatedAt: true,
        lastPushSuccessAt: true,
        pushFailures: true,
      },
    });

    res.json(device);
  } catch (error) {
    console.error("Error in updateDeviceHandler:", {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      userId: req.params.userId,
      deviceId: req.params.deviceId,
      requestBody: req.body,
      xmtpId: req.app.locals.xmtpId,
    });

    if (error instanceof z.ZodError) {
      res
        .status(400)
        .json({ error: "Invalid request body", details: error.errors });
      return;
    }

    res.status(500).json({
      error: "Failed to update device",
      details: error instanceof Error ? error.message : "Unknown error",
    });
  }
}
