import type { Request, Response } from "express";
import { getPublicServiceConfigs } from "@/api/v2/connections/bundles.config";

// GET /v2/connections/services — the connections-picker catalog.
//
// Serves the backend-owned service/bundle catalog with Composio action slugs
// stripped (see toPublicServiceConfig): clients render one card per bundle and
// persist only bundle ids; the backend alone resolves bundle → actions at exec.
//
// JWT-only (authMiddleware), NOT account-scoped: the catalog is the same for
// everyone, so requireAccount is intentionally not applied (see the mount in
// src/api/v2/index.ts). The payload is small and stable per deploy; clients
// refetch on a `version` bump (stale detection), so we set a short cache TTL.
export function servicesGetHandler(_req: Request, res: Response) {
  res.setHeader("Cache-Control", "private, max-age=300");
  res.status(200).json({ services: getPublicServiceConfigs() });
}
