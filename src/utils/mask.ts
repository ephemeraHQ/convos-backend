/**
 * Mask a secret key for logging: first 4 chars + length, never the full value.
 * Used by API-key middlewares so Datadog can correlate a bad key without
 * leaking it.
 */
export function maskKeyPrefix(key: string): string {
  if (key.length === 0) return "(empty)";
  return `${key.slice(0, 4)}... (len=${key.length})`;
}
