import crypto from "node:crypto";

const HASH_LEN = 5;
// 32-bit fingerprint encoded in base36 fits in HASH_LEN chars (HASH_LEN * log2(36) ≈ 25.85 bits).
const HASHED_SLUG_RE = new RegExp(`\\.[0-9a-z]{${HASH_LEN}}$`);

/**
 * Stable 5-char base36 hash derived from the agent ID. Used to suffix the
 * slug (`brewski.x4f9k`) so two skills with the same name don't collide on
 * URL, and so published pages aren't trivially guessable from the agent name.
 */
export function slugHash(id: string): string {
  const sha = crypto.createHash("sha1").update(id).digest("hex");
  const n = parseInt(sha.slice(0, 8), 16);
  return n.toString(36).padStart(HASH_LEN, "0").slice(-HASH_LEN);
}

/** Combine a base slug with the hash suffix derived from `id`. */
export function buildSlug(baseSlug: string, id: string): string {
  return `${baseSlug}.${slugHash(id)}`;
}

/** True when the slug already has the `.hash` suffix. */
export function isHashedSlug(slug: string): boolean {
  return HASHED_SLUG_RE.test(slug);
}

export { HASH_LEN };
