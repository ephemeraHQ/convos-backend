import type { Request, Response } from "express";
import { z } from "zod";
import { createComposioService } from "../composio.service";
import { mapComposioToResponse } from "../types";

const bodySchema = z.object({
  connectionRequestId: z.string().min(1).max(256),
});

export async function completeHandler(req: Request, res: Response) {
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
      "[Composio] complete body validation failed",
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
    const owned = await service.getIfOwned({
      connectionId: parsed.data.connectionRequestId,
      userId: deviceId,
    });
    if (!owned) {
      res.status(403).json({ error: "Connection not owned by this device" });
      return;
    }
    res.status(200).json(mapComposioToResponse(owned, deviceId));
    return;
  } catch (error) {
    req.log.error({ error, deviceId }, "[Composio] complete failed");
    res.status(502).json({ error: "Failed to complete connection" });
    return;
  }
}
