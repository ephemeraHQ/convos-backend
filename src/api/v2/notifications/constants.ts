/**
 * Maximum number of consecutive push notification failures before logging warnings
 * Note: Does not auto-disable devices; threshold is for monitoring only
 */
export const MAX_PUSH_FAILURES = 50;

/**
 * Maximum size in bytes for JWT metadata to prevent token bloat
 */
export const MAX_JWT_METADATA_SIZE = 1024; // 1KB
