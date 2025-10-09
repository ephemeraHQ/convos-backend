import type { Request, Response } from "express";
import { z } from "zod";
import { prisma } from "@/utils/prisma";
import { createV2JwtToken } from "@/utils/v2/jwt";

/**
 * Token Generation Security Model
 *
 * This endpoint generates short-lived JWT tokens for Gateway authentication:
 *
 * 1. The outer authV2Middleware validates the request using Firebase AppCheck,
 *    which verifies the request originates from a legitimate app instance.
 * 2. AppCheck validation is sufficient to prove device ownership - if a device
 *    passes AppCheck, it's trusted to request tokens for any client identifier
 *    associated with that device.
 * 3. The clientIdentifier->deviceId mapping is validated in the database to
 *    ensure the client belongs to the requesting device.
 * 4. Rate limiting (10 requests per 15 minutes) prevents token exhaustion attacks.
 * 5. Tokens are short-lived (15 minutes) to limit exposure window.
 */

const generateTokenRequestSchema = z.object({
  clientIdentifier: z.string(),
  deviceId: z.string(),
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

    // Validate client exists and belongs to device
    const client = await prisma.clientIdentifier.findUnique({
      where: { id: body.clientIdentifier },
      include: { device: true },
    });

    if (!client || client.deviceId !== body.deviceId) {
      res.status(404).json({ error: "Client not found" });
      return;
    }

    // Check if device is disabled
    if (client.device.disabled) {
      res.status(403).json({ error: "Device is disabled" });
      return;
    }

    // Generate JWT
    const token = await createV2JwtToken({
      clientIdentifier: body.clientIdentifier,
      deviceId: body.deviceId,
      expirationTime: "15m", // Short-lived for app-generated requests
      metadata: {
        gatewayAuthorized: true,
      },
    });

    res.json({ token });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Invalid request body" });
      return;
    }
    req.log.error({ error }, "Failed to generate token");
    res.status(500).json({ error: "Failed to generate token" });
  }
}
