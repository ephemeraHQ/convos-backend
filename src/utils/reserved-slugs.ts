export const RESERVED_SLUGS = new Set([
  "generate",
  "publish",
  "fork",
  "search",
  "files",
  "templates",
  "skills",
]);

export const SLUG_REGEX = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const MAX_SLUG_LENGTH = 64;

export type SlugValidationErrorReason =
  | "invalid_format"
  | "too_long"
  | "reserved";

export type SlugValidationResult =
  | { valid: true; slug: string }
  | {
      valid: false;
      reason: SlugValidationErrorReason;
      message: string;
    };

/**
 * True if `slug` is in the reserved-slug set.
 * Comparison is case-sensitive — callers must pass a lowercase slug.
 */
export function isReservedSlug(slug: string): boolean {
  return RESERVED_SLUGS.has(slug);
}

/**
 * Validate a slug against length, format, and reserved-word constraints.
 * Checks run in order: `too_long` → `invalid_format` → `reserved`.
 * Format: lowercase alphanumeric segments separated by single hyphens
 * (matches `SLUG_REGEX`).
 */
export function validateSlug(slug: string): SlugValidationResult {
  if (slug.length > MAX_SLUG_LENGTH) {
    return {
      valid: false,
      reason: "too_long",
      message: `Slug must be ${MAX_SLUG_LENGTH} characters or fewer`,
    };
  }

  if (!SLUG_REGEX.test(slug)) {
    return {
      valid: false,
      reason: "invalid_format",
      message: "Slug must match ^[a-z0-9]+(-[a-z0-9]+)*$",
    };
  }

  if (isReservedSlug(slug)) {
    return {
      valid: false,
      reason: "reserved",
      message: "Slug is reserved",
    };
  }

  return { valid: true, slug };
}

/** Convenience boolean wrapper around `validateSlug`. */
export function isValidSlug(slug: string): boolean {
  return validateSlug(slug).valid;
}
