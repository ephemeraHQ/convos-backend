import crypto from "node:crypto";

const HASH_LEN = 5;
const HASH_BITS = HASH_LEN * Math.log2(36); // ≈ 25.85 → fits in 32 bits

/**
 * Stable 5-char base36 hash derived from the agent ID. Used to suffix the
 * slug (`brewski.x4f9k`) so two skills with the same name don't collide on
 * URL, and so published pages aren't trivially guessable from the agent name.
 */
export function slugHash(id: string): string {
  const sha = crypto.createHash("sha1").update(id).digest("hex");
  // Take 32 bits, convert to base36, pad/truncate to exactly HASH_LEN chars.
  const n = parseInt(sha.slice(0, 8), 16);
  return n.toString(36).padStart(HASH_LEN, "0").slice(-HASH_LEN);
}

/** Combine a base slug with the hash suffix derived from `id`. */
export function buildSlug(baseSlug: string, id: string): string {
  return `${baseSlug}.${slugHash(id)}`;
}

/** True when the slug already has the `.hash` suffix. */
export function isHashedSlug(slug: string): boolean {
  // Hash is always exactly 5 lowercase base36 chars at the tail after a single dot.
  return new RegExp(`\\.[0-9a-z]{${HASH_LEN}}$`).test(slug);
}

export { HASH_LEN };
