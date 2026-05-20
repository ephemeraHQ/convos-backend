import { BUILDER_SITE_URL } from "@/config";
import { buildSlug } from "@/utils/slug-hash";

/**
 * Single source of truth for an agent template's public Playroom URL.
 *
 * BUILDER_SITE_URL is the env-specific Playroom origin (dev.convos.org /
 * convos.org). The trailing slash is stripped so a configured value with
 * or without one yields the same result (no `//` in the path). Agent pages
 * live under the `/a/` segment; the final path component is the canonical
 * `<base>.<hash>` hashed slug that resolve-id-or-hashed-slug.ts matches.
 */

/** origin + an already-hashed `<base>.<hash>` slug → full public URL */
export function templateUrlFromHashedSlug(hashedSlug: string): string {
  return `${BUILDER_SITE_URL.replace(/\/+$/, "")}/a/${hashedSlug}`;
}

/** template row (base slug + id) → full public URL */
export function templatePublicUrl(baseSlug: string, id: string): string {
  return templateUrlFromHashedSlug(buildSlug(baseSlug, id));
}
