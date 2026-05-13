import type { Response } from "express";

/**
 * Returns the effective owner account ID for the current request.
 *
 * When API key auth is used, `res.locals.accountId` is set to
 * `ADMIN_ACCOUNT_ID` by `authOrAgentApiKeyAuth`. When JWT auth is used,
 * `res.locals.accountId` comes from the verified JWT payload via
 * `authMiddleware`. On routes that use `optionalAuthOrAgentApiKeyAuth`
 * and the caller did not present credentials, this returns `undefined`
 * — handlers must decide whether to coalesce to a fallback or reject.
 *
 * Callers should use this instead of hardcoding `ADMIN_ACCOUNT_ID` so
 * that per-account ownership works when SIWE-authenticated users create
 * resources.
 */
export function getEffectiveOwnerId(res: Response): string | undefined {
  return res.locals.accountId;
}
