import type { ConnectedAccountListResponseItem } from "@composio/core";
import type { Request, Response } from "express";
import { createComposioService } from "../composio.service";
import { mapComposioToResponse } from "../types";

export async function listHandler(req: Request, res: Response) {
  const deviceId = res.locals.deviceId;
  if (!deviceId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const service = createComposioService();
  if (!service) {
    res.status(503).json({ error: "Connections not configured" });
    return;
  }

  try {
    const list = await service.listForUser(deviceId);
    const items: ConnectedAccountListResponseItem[] = list.items;
    res.status(200).json({
      connections: items.map((item) => mapComposioToResponse(item, deviceId)),
    });
    return;
  } catch (error) {
    req.log.error({ error, deviceId }, "[Composio] list failed");
    res.status(502).json({ error: "Failed to list connections" });
    return;
  }
}
