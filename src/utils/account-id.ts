import { z } from "zod";

/**
 * Canonical account-id shape. Account ids are UUIDs (`Account.id` is
 * `@db.Uuid`; JWTs carry the same value). All account-id validation must
 * import this schema — hand-rolled `z.string().uuid()` copies drift.
 */
export const accountIdSchema = z.string().uuid();
