import type { Request, Response } from "express";
import {
  getKnownActions,
  getServiceConfig,
} from "@/api/v2/connections/bundles.config";
import { createComposioService } from "@/api/v2/connections/composio.service";

// GET /v2/connections/services/:toolkit/actions — the action-slug vocabulary
// the agent runtime validates a requested slug against BEFORE calling exec.
//
// Why this exists: the agent picks the Composio action slug as a free-form
// string. When it guesses wrong (e.g. "listEvents", the retired
// "GOOGLECALENDAR_LIST_EVENTS"), exec fails with `no_grant` — the SAME code a
// real consent gap returns — and the agent re-prompts the user to re-approve a
// connection that was never the problem (the calendar re-auth loop). Serving
// the canonical slug list lets the agent fail a typo locally as
// `invalid_action`, never confusing it with consent.
//
// This is the toolkit's full VALID slug vocabulary sourced from Composio's LIVE
// catalog (not our consent bundles), NOT a per-grant authorization — exec still
// enforces the grant's resolved scope. The slugs reveal nothing a successful
// exec wouldn't, so auth mirrors exec exactly (composioExecAuth /
// X-Composio-Exec-Key): the trusted worker reaches this with the same credential
// it uses to forward exec, never a per-user JWT.
//
// New Composio toolkit releases flow to the agent on the next fetch (bounded by
// the service-side catalog cache TTL) with no agent/app release — the agent
// validates a requested slug against this list before exec to avoid the
// invalid-slug -> no_grant confusion that drove the calendar re-auth loop.
export async function actionsGetHandler(req: Request, res: Response) {
  const toolkit = String(req.params.toolkit).trim();
  const svc = getServiceConfig(toolkit);
  if (!svc) {
    res.status(404).json({ code: "unknown_toolkit", toolkit });
    return;
  }
  const service = createComposioService();
  if (!service) {
    res.status(503).json({ error: "Connections not configured" });
    return;
  }
  // Same short TTL as the picker catalog: small, stable per deploy.
  res.setHeader("Cache-Control", "private, max-age=300");
  res.status(200).json({
    toolkit: svc.id,
    composioSlug: svc.composioSlug,
    version: svc.version,
    actions: await getKnownActions(service, svc.id),
  });
}
