import { Prisma } from "@prisma/client";
import type { Request, Response } from "express";
import { getBalance, grant as grantCredits } from "@/payments";
import { IdempotencyMismatchError } from "@/payments/errors";
import { isAccountIdFkViolation } from "../fk-violation";
import { grantRequestSchema } from "../schemas";

export async function grant(req: Request, res: Response): Promise<void> {
  const parsed = grantRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "Validation Error",
      details: parsed.error.flatten(),
    });
    return;
  }
  const { accountId, credits, grantKindId, idempotencyKey, note } = parsed.data;

  try {
    const result = await grantCredits({
      accountId,
      credits,
      kind: grantKindId,
      idempotencyKey,
      note,
    });
    // `balance` is advisory: read after the grant commit, not isolated with the
    // grant transaction. Concurrent grants could make this value reflect a
    // later state.
    const balance = await getBalance(accountId);
    res.status(200).json({
      granted: result.granted,
      balance: balance.toString(),
      replayed: result.replayed,
    });
  } catch (err) {
    if (err instanceof IdempotencyMismatchError) {
      res.status(409).json({
        error: err.message,
        code: "idempotency_mismatch",
        details: err.details,
      });
      return;
    }
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      isAccountIdFkViolation(err)
    ) {
      req.log.warn({ accountId }, "credits.grant.account_not_found");
      res.status(409).json({
        error: "Account not found",
        code: "account_not_found",
      });
      return;
    }
    throw err;
  }
}
