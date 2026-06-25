/**
 * Normalize a share-card job title: trim, collapse internal whitespace to
 * single spaces, and treat an all-whitespace or empty result as "no title"
 * (null) so the column stays clean for the card renderer.
 *
 * The ≤3-word / ≤10-char-per-word limits are steered by the generator
 * prompt, not enforced here — this only guarantees a clean single-line
 * label or null. Shared by the generator parse path and the manual
 * create/patch handlers so every writer normalizes identically.
 */
export function normalizeJobTitle(
  input: string | null | undefined,
): string | null {
  if (typeof input !== "string") return null;
  const cleaned = input.trim().replace(/\s+/g, " ");
  return cleaned === "" ? null : cleaned;
}
