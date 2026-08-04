import type { Request, Response } from "express";
import { noteV1ConnectionDeleted } from "@/api/v2/connections/v1-connection-adapter";
import { createComposioService } from "../composio.service";

export async function deleteHandler(
  req: Request<{ id: string }>,
  res: Response,
) {
  const accountId = res.locals.accountId;
  if (!accountId) {
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
      userId: accountId,
    });
    if (!owned) {
      res.status(403).json({ error: "Connection not owned by this account" });
      return;
    }
    await service.delete(connectionId);
    // Mirror into the entitlement tables (best-effort; never changes the V1
    // wire): re-derive from the remaining connections, or tombstone when the
    // last one went.
    await noteV1ConnectionDeleted({
      accountId,
      toolkitSlug: owned.toolkit.slug,
      service,
    });
    res.status(204).send();
    return;
  } catch (error) {
    req.log.error(
      { error, accountId, connectionId },
      "[Composio] delete failed",
    );
    res.status(502).json({ error: "Failed to delete connection" });
    return;
  }
}
