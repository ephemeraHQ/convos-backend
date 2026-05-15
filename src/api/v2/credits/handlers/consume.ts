import { Prisma } from "@prisma/client";
import type { Request, Response } from "express";
import { consume as consumeCredits, getBalance } from "@/payments";
import {
  IdempotencyMismatchError,
  InsufficientBalanceError,
} from "@/payments/errors";
import { isAccountIdFkViolation } from "../fk-violation";
import { consumeRequestSchema } from "../schemas";

export async function consume(req: Request, res: Response): Promise<void> {
  const parsed = consumeRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "Validation Error",
      details: parsed.error.flatten(),
    });
    return;
  }
  const { accountId, usdCostMicros, idempotencyKey, requestId, model } =
    parsed.data;

  try {
    const result = await consumeCredits({
      accountId,
      usdCostMicros,
      idempotencyKey,
      requestId,
      model,
    });
    // `balance` is advisory: read after the consume commit, so concurrent
    // consumes on the same account may make this value reflect a later state.
    // Hermes uses it only as a UI signal, not for accounting.
    const balance = await getBalance(accountId);
    res.status(200).json({
      spent: result.spent,
      balance: balance.toString(),
      replayed: result.replayed,
    });
  } catch (err) {
    if (err instanceof InsufficientBalanceError) {
      res.status(402).json({
        error: err.message,
        code: "insufficient_balance",
        details: err.details,
      });
      return;
    }
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
      req.log.warn({ accountId }, "credits.consume.account_not_found");
      res.status(409).json({
        error: "Account not found",
        code: "account_not_found",
      });
      return;
    }
    throw err;
  }
}
