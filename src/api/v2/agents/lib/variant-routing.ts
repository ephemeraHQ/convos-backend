import { prisma } from "@/utils/prisma";

// A variant is live — routable + stampable — only while ready/building and not
// expired. Mirrors the picker's GET filter so a client can't pin a failed/stale/
// expired slug by passing it directly.
export function liveVariantWhere(slug: string) {
  return {
    slug,
    status: { in: ["ready", "building"] },
    OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
  };
}

// Variant rows store a free-form URL; only our HTTPS dev ephemeral origins
// (ephemeral-<slug>.convos.fun, default port) may receive a dispatch/poll and its
// bearer token. Returns the canonical origin (scheme + host only) to route at, or
// null to fall back to the default worker — normalizing to the origin means an
// injected port, path, or query on an otherwise-trusted host can't redirect the
// bearer. This pattern is a cross-repo contract with the convos-assistants
// ephemeral host (EPHEMERAL_PREFIX + ROUTE_ZONE in scripts/ephemeral.ts,
// registered by variant.yml) — keep the two in lockstep or variant routing
// silently falls back.
export function allowedVariantWorkerOrigin(url: string): string | null {
  try {
    const parsed = new URL(url);
    const allowed =
      parsed.protocol === "https:" &&
      (parsed.port === "" || parsed.port === "443") &&
      /^ephemeral-[a-z0-9-]+\.convos\.fun$/.test(parsed.hostname);
    return allowed ? parsed.origin : null;
  } catch {
    return null;
  }
}

// Resolve a variant slug to the allowed ephemeral worker origin to route at, or
// null (unknown / retired / expired / off-host → default worker). A DB error
// degrades to null rather than throwing. Callers gate on the dev network.
export async function resolveVariantWorkerOrigin(
  slug: string,
): Promise<string | null> {
  try {
    const variant = await prisma.agentVariant.findFirst({
      where: liveVariantWhere(slug),
      select: { assistantWorkerUrl: true },
    });
    if (!variant?.assistantWorkerUrl) return null;
    return allowedVariantWorkerOrigin(variant.assistantWorkerUrl);
  } catch {
    return null;
  }
}
