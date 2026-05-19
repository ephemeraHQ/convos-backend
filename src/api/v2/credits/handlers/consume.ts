import { Prisma } from "@prisma/client";
import type { Request, Response } from "express";
import { consume as consumeCredits } from "@/payments";
import {
  IdempotencyMismatchError,
  InsufficientBalanceError,
} from "@/payments/errors";
import { isAccountIdFkViolation } from "../fk-violation";
import { consumeRequestSchema } from "../schemas";

export async function consume(req: Request, res: Response): Promise<void> {
  const { accountId, usdCostMicros, idempotencyKey, requestId, model } =
    consumeRequestSchema.parse(req.body);

  try {
    const result = await consumeCredits({
      accountId,
      usdCostMicros,
      idempotencyKey,
      requestId,
      model,
    });
    req.log.info(
      { accountId, spent: result.spent, replayed: result.replayed, requestId },
      result.replayed ? "credits.consume.replayed" : "credits.consume.accepted",
    );
    res.status(200).json({
      spent: result.spent,
      balance: result.newBalance.toString(),
      replayed: result.replayed,
    });
  } catch (err) {
    if (err instanceof InsufficientBalanceError) {
      req.log.info({ accountId }, "credits.consume.insufficient_balance");
      res.status(402).json({
        error: err.message,
        code: "insufficient_balance",
        details: err.details,
      });
      return;
    }
    if (err instanceof IdempotencyMismatchError) {
      req.log.info(
        { accountId, idempotencyKey },
        "credits.consume.idempotency_mismatch",
      );
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
