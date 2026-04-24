import type { Request, Response } from "express";
import { z } from "zod";
import { createComposioService } from "../composio.service";

const bodySchema = z.object({
  serviceId: z.string().min(1).max(128),
  // Optional per-environment callback URL (e.g. "convos://connections/callback",
  // "convos-dev://connections/callback"). Falls back to the backend's default
  // COMPOSIO_CONNECTION_CALLBACK_URL when absent.
  redirectUri: z.string().url().max(2048).optional(),
});

export async function initiateHandler(req: Request, res: Response) {
  const deviceId = res.locals.deviceId;
  if (!deviceId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    req.log.warn(
      {
        deviceId,
        issues: parsed.error.issues,
        receivedBody: req.body as unknown,
        contentType: req.header("content-type"),
      },
      "[Composio] initiate body validation failed",
    );
    res.status(400).json({
      error: "Invalid request body",
      details: parsed.error.issues,
    });
    return;
  }

  const service = createComposioService();
  if (!service) {
    res.status(503).json({ error: "Connections not configured" });
    return;
  }

  try {
    const authConfigId = await service.resolveAuthConfigId(
      parsed.data.serviceId,
    );
    if (!authConfigId) {
      req.log.warn(
        { deviceId, serviceId: parsed.data.serviceId },
        "[Composio] no ENABLED auth config found for serviceId",
      );
      res.status(400).json({
        error: "Unknown or disabled serviceId",
        serviceId: parsed.data.serviceId,
      });
      return;
    }

    const request = await service.initiate({
      userId: deviceId,
      authConfigId,
      callbackUrl: parsed.data.redirectUri,
    });
    res.status(200).json({
      connectionRequestId: request.id,
      redirectUrl: request.redirectUrl ?? null,
    });
    return;
  } catch (error) {
    req.log.error({ error, deviceId }, "[Composio] initiate failed");
    res.status(502).json({ error: "Failed to initiate connection" });
    return;
  }
}
