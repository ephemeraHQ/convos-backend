import { DeviceSchema } from "@prisma-zod/index";
import { type Request, type Response } from "express";
import { z } from "zod";
import { AppError, logError } from "@/utils/errors";
import { prisma } from "@/utils/prisma";

export type UpdateDeviceRequestParams = {
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
    const { deviceId } = req.params;
    const { xmtpId } = res.locals;

    // Verify the authenticated identity exists
    const identity = await prisma.deviceIdentity.findFirst({
      where: { xmtpId },
      select: { id: true },
    });

    if (!identity) {
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
        identities: { some: { identityId: identity.id } },
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
        deviceId,
        xmtpId,
        reason: "Device not found or not associated with user",
      });
      res
        .status(404)
        .json({ error: "Device not found or not associated with this user" });
      return;
    }

    // Re-fetch the updated device with ownership check to return to client
    const device = await prisma.device.findFirst({
      where: {
        id: deviceId,
        identities: { some: { identityId: identity.id } },
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
      logError(new Error("Device ownership lost after update"), {
        deviceId,
        xmtpId,
        reason: "Device not found or ownership changed after update",
      });
      res
        .status(404)
        .json({ error: "Device not found or not associated with this user" });
      return;
    }

    res.json(device);
    return;
  } catch (error) {
    logError(error, {
      deviceId: req.params.deviceId,
      xmtpId: res.locals.xmtpId,
      requestBodyMetadata: {
        hasPushToken: Boolean(req.body.pushToken),
        pushTokenType: typeof req.body.pushTokenType,
        hasPushTokenType: Boolean(req.body.pushTokenType),
        hasApnsEnv: Boolean(req.body.apnsEnv),
        hasName: Boolean(req.body.name),
        hasOs: Boolean(req.body.os),
        hasAppVersion: Boolean(req.body.appVersion),
        hasAppBuildNumber: Boolean(req.body.appBuildNumber),
      },
    });

    if (error instanceof z.ZodError) {
      res
        .status(400)
        .json({ error: "Invalid request body", details: error.errors });
      return;
    }

    if (error instanceof AppError) {
      res.status(error.statusCode).json({
        error: error.message,
        details: error.details,
      });
      return;
    }

    // Fallback for unexpected errors - no internal details exposed
    res.status(500).json({
      error: "Failed to update device",
    });
    return;
  }
}
