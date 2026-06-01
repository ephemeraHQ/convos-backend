import { Prisma } from "@prisma/client";
import type { Request, Response } from "express";
import {
  accountIdParamSchema,
  transactionRequestSchema,
} from "@/api/v2/accounts/schemas/credits-by-id";
import { idempotencyKeySchema } from "@/api/v2/accounts/schemas/shared";
import {
  consume,
  IdempotencyMismatchError,
  InsufficientBalanceError,
} from "@/payments";

/**
 * POST /v2/accounts/:accountId/credits/transactions
 *
 * Stripe-style idempotent consume endpoint. Idempotency-Key comes from header
 * (not body — spec § 3.2). The :accountId param is pre-validated as UUID by
 * meGuard (mounted in accountsByIdRouter, Task 14).
 *
 * Response shape:
 *   200  { ledgerId, delta: string, balance: string }
 *        Header: Idempotent-Replayed: "true" | "false"
 *   400  { code: "invalid_idempotency_key" } — missing or malformed key
 *   400  { code: "invalid_request", issues: [...] } — body validation failure
 *   402  { code: "insufficient_balance" } — balance would breach floor
 *   404  { code: "account_not_found" } — FK violation (no Account row)
 *   409  { code: "idempotency_mismatch" } — same key, different body
 */
export const creditsTransactionsPostHandler = async (
  req: Request<{ accountId: string }>,
  res: Response,
): Promise<void> => {
  // meGuard already validated accountId UUID shape.
  const { accountId } = accountIdParamSchema.parse(req.params);

  const headerKey = req.get("Idempotency-Key") ?? "";
  const keyResult = idempotencyKeySchema.safeParse(headerKey);
  if (!keyResult.success) {
    req.log.warn(
      {
        accountId,
        keyLength: headerKey.length,
        disallowedChars: [...new Set(headerKey.replace(/[A-Za-z0-9_-]/g, ""))],
      },
      "credits.transaction.invalid_idempotency_key",
    );
    res.status(400).json({ code: "invalid_idempotency_key" });
    return;
  }

  const bodyResult = transactionRequestSchema.safeParse(req.body);
  if (!bodyResult.success) {
    req.log.warn(
      { accountId, issueCount: bodyResult.error.issues.length },
      "credits.transaction.invalid_request",
    );
    res
      .status(400)
      .json({ code: "invalid_request", issues: bodyResult.error.issues });
    return;
  }
  const { usdCostMicros, requestId, model } = bodyResult.data;

  try {
    const result = await consume({
      accountId,
      usdCostMicros,
      idempotencyKey: keyResult.data,
      requestId,
      model,
    });

    res.setHeader("Idempotent-Replayed", result.replayed ? "true" : "false");
    const event = result.replayed
      ? "credits.transaction.replayed"
      : "credits.transaction.accepted";
    req.log.info(
      {
        accountId,
        ledgerId: result.ledgerId,
        delta: BigInt(-result.spent).toString(),
        balanceAfter: result.balanceAfter.toString(),
        requestId,
        ...(model ? { model } : {}),
      },
      event,
    );
    res.status(200).json({
      ledgerId: result.ledgerId,
      delta: BigInt(-result.spent).toString(),
      balance: result.balanceAfter.toString(),
    });
  } catch (err) {
    if (err instanceof InsufficientBalanceError) {
      req.log.warn(
        { accountId, attemptedDelta: usdCostMicros.toString() },
        "credits.transaction.insufficient_balance",
      );
      res.status(402).json({ code: "insufficient_balance" });
      return;
    }
    if (err instanceof IdempotencyMismatchError) {
      req.log.warn(
        { accountId, idempotencyKey: keyResult.data },
        "credits.transaction.idempotency_mismatch",
      );
      res.status(409).json({ code: "idempotency_mismatch" });
      return;
    }
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      // P2003 = Prisma model FK violation.
      // P2010 wrapping PG SQLSTATE 23503 = same FK violation surfaced via $queryRaw
      // (lockOrCreateBalance writes UserCredits with raw SQL).
      (err.code === "P2003" ||
        (err.code === "P2010" &&
          (err.meta as { code?: string } | undefined)?.code === "23503"))
    ) {
      req.log.warn({ accountId }, "credits.transaction.account_not_found");
      res.status(404).json({ code: "account_not_found" });
      return;
    }
    throw err;
  }
};
