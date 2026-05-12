// Keep this list in sync with the CHECK constraint on AuthMethod.type
// in prisma/migrations/20260508120812_authentication_api/migration.sql.
export const AUTH_METHOD_TYPES = ["SIWE"] as const;

export type AuthMethodType = (typeof AUTH_METHOD_TYPES)[number];
