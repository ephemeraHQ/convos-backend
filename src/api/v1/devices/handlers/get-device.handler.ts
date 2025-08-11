import { type Request, type Response } from "express";
import { AppError, logError } from "@/utils/errors";
import { prisma } from "@/utils/prisma";

export type GetDeviceRequestParams = {
  userId: string;
  deviceId: string;
};

export async function getDeviceHandler(
  req: Request<GetDeviceRequestParams>,
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
        .json({ error: "Not authorized to access this user's devices" });
      return;
    }

    // Check if device exists and is associated with the user
    const device = await prisma.device.findFirst({
      where: {
        id: deviceId,
        users: {
          some: {
            userId: user.id,
          },
        },
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

    if (!device) {
      // Security-relevant event: ownership check miss (sanitized)
      // Note: don't log pushToken or other sensitive values
      logError(new Error("device-get-ownership-miss"), {
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

    res.json(device);
  } catch (error) {
    logError(error, {
      userId: req.params.userId,
      deviceId: req.params.deviceId,
      xmtpId: req.app.locals.xmtpId,
    });

    if (error instanceof AppError) {
      res.status(error.statusCode).json({
        error: error.message,
        details: error.details,
      });
      return;
    }

    res.status(500).json({ error: "Failed to fetch device" });
    return;
  }
}
