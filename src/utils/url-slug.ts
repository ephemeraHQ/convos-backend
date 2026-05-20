import crypto from "node:crypto";

// 32-bit fingerprint encoded in base36 fits in 5 chars (5 * log2(36) ≈ 25.85 bits).
const HASH_LEN = 5;
const HASHED_SLUG_RE = /\.[0-9a-z]{5}$/;
// 5-char base36 ≈ 67M values. Birthday math: ~1% collision among 1.1k records
// sharing a base slug, ~50% at 9k. We retry with a fresh ID on collision; cap
// attempts so a poisoned base slug can't spin forever.
const MAX_SLUG_ATTEMPTS = 8;

/**
 * Stable 5-char base36 hash derived from the agent ID. Used to suffix the
 * slug (`brewski.x4f9k`) so two skills with the same name don't collide on
 * URL, and so published pages aren't trivially guessable from the agent name.
 */
export function hashId(id: string): string {
  const sha = crypto.createHash("sha1").update(id).digest("hex");
  const n = parseInt(sha.slice(0, 8), 16);
  return n.toString(36).padStart(HASH_LEN, "0").slice(-HASH_LEN);
}

/** Combine a base slug with the hash suffix derived from `id`. */
export function buildUrlSlug(baseSlug: string, id: string): string {
  return `${baseSlug}.${hashId(id)}`;
}

/** True when the slug already has the `.hash` suffix. */
export function isUrlSlug(slug: string): boolean {
  return HASHED_SLUG_RE.test(slug);
}

/**
 * Reserve a unique url slug for a record. Generates a fresh ID per attempt
 * so a hash collision picks a new suffix instead of clobbering an existing
 * row. Returns the chosen `{ id, slug }` so the caller persists both.
 *
 * Callers should still rely on a DB unique constraint on `slug` as the final
 * arbiter — `isTaken` and the eventual insert race, and the constraint is
 * what keeps that race correct.
 */
export async function buildUniqueUrlSlug(args: {
  baseSlug: string;
  idFactory: () => string;
  isTaken: (slug: string) => Promise<boolean>;
}) {
  const { baseSlug, idFactory, isTaken } = args;
  for (let i = 0; i < MAX_SLUG_ATTEMPTS; i++) {
    const id = idFactory();
    const slug = buildUrlSlug(baseSlug, id);
    if (!(await isTaken(slug))) {
      return { id, slug };
    }
  }
  throw new Error(
    `slug collision: exhausted ${MAX_SLUG_ATTEMPTS} attempts for base slug "${baseSlug}"`,
  );
}

export { HASH_LEN, MAX_SLUG_ATTEMPTS };
