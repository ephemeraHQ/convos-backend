import type { Request, Response } from "express";
import { getBalance } from "@/payments";
import { isAllowedFromBalance } from "@/payments/credits/policy";
import { checkRequestSchema } from "../schemas";

// Note: validation failures return 400 from the global errorHandlerMiddleware
// without a `code` field — consistent with the rest of the v2 API. Adding a
// `code` field on validation 400s is a cross-cutting follow-up, not a per-handler concern.
export async function check(req: Request, res: Response): Promise<void> {
  const { accountId } = checkRequestSchema.parse(req.body);
  const balance = await getBalance(accountId);
  const allowed = isAllowedFromBalance(balance);
  req.log.info(
    { accountId, allowed, balance: balance.toString() },
    allowed ? "credits.check.allowed" : "credits.check.denied",
  );
  res.status(200).json({ allowed, balance: balance.toString() });
}
