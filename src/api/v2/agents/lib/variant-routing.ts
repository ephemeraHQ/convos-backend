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

// The ephemeral worker host for a variant slug. Cross-repo contract with the
// convos-assistants ephemeral host (EPHEMERAL_PREFIX + ROUTE_ZONE in
// scripts/ephemeral.ts, registered by variant.yml) — keep the two in lockstep or
// variant routing silently falls back.
export function variantWorkerHostname(slug: string): string {
  return `ephemeral-${slug}.convos.fun`;
}

// A variant's dispatch/poll and its bearer token may go ONLY to the variant's
// own HTTPS ephemeral origin (default port). Binding to the exact expected
// hostname — not just the ephemeral-*.convos.fun shape — stops a bad/mismatched
// row (e.g. pr-123 pointing at pr-999's worker) from leaking the bearer to
// another PR's runtime; returning the canonical origin (scheme + host only)
// strips any injected port/path/query.
export function allowedVariantWorkerOrigin(
  url: string,
  expectedHostname: string,
): string | null {
  try {
    const parsed = new URL(url);
    const allowed =
      parsed.protocol === "https:" &&
      (parsed.port === "" || parsed.port === "443") &&
      parsed.hostname === expectedHostname;
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
    return allowedVariantWorkerOrigin(
      variant.assistantWorkerUrl,
      variantWorkerHostname(slug),
    );
  } catch {
    return null;
  }
}
