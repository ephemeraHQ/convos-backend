import type { Request, Response } from "express";
import { createComposioService } from "../composio.service";

export async function deleteHandler(req: Request, res: Response) {
  const deviceId = res.locals.deviceId;
  if (!deviceId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const connectionId = req.params.id;
  if (!connectionId) {
    res.status(400).json({ error: "Missing connection id" });
    return;
  }

  const service = createComposioService();
  if (!service) {
    res.status(503).json({ error: "Connections not configured" });
    return;
  }

  try {
    const owned = await service.getIfOwned({
      connectionId,
      userId: deviceId,
    });
    if (!owned) {
      res.status(403).json({ error: "Connection not owned by this device" });
      return;
    }
    await service.delete(connectionId);
    res.status(204).send();
    return;
  } catch (error) {
    req.log.error(
      { error, deviceId, connectionId },
      "[Composio] delete failed",
    );
    res.status(502).json({ error: "Failed to delete connection" });
    return;
  }
}
