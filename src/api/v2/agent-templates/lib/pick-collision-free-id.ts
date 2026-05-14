/**
 * Pick a row id whose `slugHash(id)` doesn't collide with any existing
 * AgentTemplate row sharing the given `baseSlug` — ACROSS owners.
 *
 * Context: AgentTemplate slugs are NOT unique — there is no DB constraint,
 * so any number of rows (within or across owners) can share a base slug.
 * The public hashed URL `<base>.<hash5>` is what disambiguates them, so it
 * is load-bearing: this helper pre-picks a row id whose hash doesn't
 * collide with any existing row on the same base. With ~67M values in the
 * 5-char base36 space, collisions are negligible at small scale but grow
 * with the birthday bound (~1% at 1.1k rows sharing a base, ~50% at 9k).
 *
 * Residual race: between this read and the subsequent INSERT, a concurrent
 * transaction could insert a row whose hash collides with our pick. For
 * that to produce a real collision, two writes need to land in the same
 * sub-ms window, share the same base slug, and have UUIDs that hash to
 * the same 5 chars. Compound probability is negligible at our scale;
 * revisit with a SERIALIZABLE transaction or a stored urlHash unique
 * index if collisions ever surface in monitoring.
 *
 * Used by both the CRUD create path (handlers/create.ts) and the async
 * generation pipeline (services/generation-executor.ts) so both surfaces
 * mint hash-unique URLs by the same policy.
 */

import { randomUUID } from "node:crypto";
import { prisma } from "@/utils/prisma";
import { buildUniqueSlug, slugHash } from "@/utils/slug-hash";

export async function pickCollisionFreeId(args: {
  baseSlug: string;
}): Promise<string> {
  const { id } = await buildUniqueSlug({
    baseSlug: args.baseSlug,
    idFactory: () => randomUUID(),
    isTaken: async (candidate) => {
      const dot = candidate.lastIndexOf(".");
      const base = candidate.slice(0, dot);
      const hash = candidate.slice(dot + 1);
      const rows = await prisma.agentTemplate.findMany({
        where: { slug: base },
        select: { id: true },
      });
      return rows.some((row) => slugHash(row.id) === hash);
    },
  });
  return id;
}
