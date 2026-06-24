import type { Request, Response } from "express";
import {
  getKnownActions,
  getServiceConfig,
} from "@/api/v2/connections/bundles.config";

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
// This is the toolkit's full slug vocabulary (union across all bundles,
// deprecated included), NOT a per-grant authorization — exec still enforces the
// grant's resolved scope. The slugs are a security boundary only in the sense
// that they are backend-owned; exposing the catalog's own slug names to a
// trusted agent reveals nothing a successful exec wouldn't. So this endpoint is
// JWT-only like the picker catalog, not account-scoped.
//
// Catalog changes (add/rename a slug, bump a service `version`) flow to the
// agent on the next fetch with no agent/app release — the whole point of one
// source of truth in bundles.config.ts.
export function actionsGetHandler(req: Request, res: Response) {
  const toolkit = String(req.params.toolkit).trim();
  const svc = getServiceConfig(toolkit);
  if (!svc) {
    res.status(404).json({ code: "unknown_toolkit", toolkit });
    return;
  }
  // Same short TTL as the picker catalog: small, stable per deploy, refetched
  // on a version bump.
  res.setHeader("Cache-Control", "private, max-age=300");
  res.status(200).json({
    toolkit: svc.id,
    composioSlug: svc.composioSlug,
    version: svc.version,
    actions: getKnownActions(svc.id),
  });
}
