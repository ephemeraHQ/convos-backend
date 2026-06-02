import type { NextFunction, Request, Response } from "express";
import { z } from "zod";

const accountIdSchema = z.string().uuid();

/**
 * Reject any :accountId path param that is not a valid UUID. UUID parsing IS
 * the case-sensitivity defense (no Express case-sensitive routing flag is
 * needed or used — sub-routers don't inherit the app-level setting).
 *
 * Mounted by accountsByIdRouter only; the JWT /me/* surface lives under a
 * separate accountsMeRouter and never reaches this middleware.
 */
export const meGuard = (
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  const r = accountIdSchema.safeParse(req.params.accountId);
  if (!r.success) {
    req.log.warn(
      { accountIdParam: String(req.params.accountId).slice(0, 64) },
      "accounts.invalid_account_id",
    );
    res.status(400).json({ code: "invalid_account_id" });
    return;
  }
  next();
};
