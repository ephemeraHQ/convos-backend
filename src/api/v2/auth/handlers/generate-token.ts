import type { Request, Response } from "express";
import { z } from "zod";
import { prisma } from "@/utils/prisma";
import { createV2JwtToken } from "@/utils/jwt";

/**
 * Token Generation Security Model
 *
 * This endpoint generates short-lived JWT tokens for NSE/Gateway authentication:
 *
 * 1. The outer authV2Middleware validates the request using Firebase AppCheck,
 *    which verifies the request originates from a legitimate app instance.
 * 2. AppCheck validation is sufficient to prove device ownership.
 * 3. Device does NOT need to be registered yet - token generation works independently.
 * 4. If device is registered and disabled, token generation is rejected.
 * 5. Rate limiting prevents token exhaustion attacks.
 * 6. Tokens are short-lived (15 minutes) to limit exposure window.
 * 7. The JWT contains only deviceId - handlers receive clientId in request bodies.
 */

const generateTokenRequestSchema = z.object({
  deviceId: z.string().uuid(),
});

export type IGenerateTokenRequestBody = z.infer<
  typeof generateTokenRequestSchema
>;

export async function generateToken(
  req: Request<unknown, unknown, IGenerateTokenRequestBody>,
  res: Response,
) {
  try {
    const body = generateTokenRequestSchema.parse(req.body);

    req.log.info({ deviceId: body.deviceId }, "Generating token");

    // Check if device is registered and disabled
    const device = await prisma.deviceRegistration.findUnique({
      where: { deviceId: body.deviceId },
    });

    if (device?.disabled) {
      req.log.warn({ deviceId: body.deviceId }, "Device is disabled");
      res.status(403).json({ error: "Device is disabled" });
      return;
    }

    // Generate JWT, this works even if device not registered yet
    const token = await createV2JwtToken({
      deviceId: body.deviceId,
      expirationTime: "15m",
    });

    req.log.info(
      { deviceId: body.deviceId, deviceRegistered: !!device },
      "Token generated successfully",
    );
    res.json({ token });
    return;
  } catch (error) {
    if (error instanceof z.ZodError) {
      req.log.warn(
        { errors: error.errors },
        "Invalid request body for generate-token",
      );
      res.status(400).json({ error: "Invalid request body" });
      return;
    }
    req.log.error({ error }, "Failed to generate token");
    res.status(500).json({ error: "Failed to generate token" });
    return;
  }
}
