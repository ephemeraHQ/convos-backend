import { Prisma } from "@prisma/client";
import type { Request, Response } from "express";
import { consume as consumeCredits, getBalance } from "@/payments";
import {
  IdempotencyMismatchError,
  InsufficientBalanceError,
} from "@/payments/errors";
import { consumeRequestSchema } from "../schemas";

/**
 * Returns true only when the Prisma FK-violation error is for the accountId
 * foreign key. A future FK column on CreditLedger (e.g. agentId) would
 * produce a different constraint name and must NOT be classified as
 * account_not_found.
 *
 * P2003: typed query path — Prisma exposes meta.field_name (FK column name).
 * P2010: $queryRaw path — Postgres SQLSTATE 23503 with constraint name in msg.
 */
const isAccountIdFkViolation = (
  err: Prisma.PrismaClientKnownRequestError,
): boolean => {
  if (err.code === "P2003") {
    const field = (err.meta as { field_name?: string } | undefined)?.field_name;
    return typeof field === "string" && field.includes("accountId");
  }
  if (err.code === "P2010") {
    const meta = err.meta as { code?: string; message?: string } | undefined;
    if (meta?.code !== "23503") return false;
    const msg = meta.message ?? "";
    return (
      msg.includes("UserCredits_accountId_fkey") ||
      msg.includes("CreditLedger_accountId_fkey")
    );
  }
  return false;
};

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
