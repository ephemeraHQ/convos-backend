// Shared helpers that turn the caller-supplied connection slugs into the
// `connections` array on a generated template. Used by both generation paths:
// the async executor (persists the template) and the ephemeral handler (returns
// it inline). Kept here so the normalize + overlay logic lives in one place.

import { getServiceConfig } from "@/api/v2/connections/bundles.config";

/** Normalize raw connection slugs to canonical, deduplicated catalog service
 *  ids. The caller (each generation handler) validated every slug against the
 *  same catalog before this point, so entries resolve; an unknown id (e.g. a
 *  service retired between submit and run) is dropped fail-closed rather than
 *  carried onto the template. Storing the catalog's neutral `id` keeps the
 *  template agnostic to the connection provider — the vendor binding lives only
 *  in the catalog + exec layers. */
export function resolveConnectionIds(
  raw: string[] | null | undefined,
): string[] {
  if (!raw || raw.length === 0) return [];
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const slug of raw) {
    const svc = getServiceConfig(slug);
    if (svc && !seen.has(svc.id)) {
      seen.add(svc.id);
      ids.push(svc.id);
    }
  }
  return ids;
}

/** Overlay the resolved connection ids onto a generated template, replacing the
 *  generator's hardcoded `connections: []`. The bridge that lets downstream
 *  provisioning issue a grant per connection once the agent has an inbox in a
 *  conversation. No-op when nothing connected (keeps the existing []). */
export function applyConnections<T extends { connections: string[] }>(
  template: T,
  connectionIds: string[],
): T {
  if (connectionIds.length === 0) return template;
  return { ...template, connections: connectionIds };
}
