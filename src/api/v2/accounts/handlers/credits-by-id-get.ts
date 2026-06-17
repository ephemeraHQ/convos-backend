import type { Request, Response } from "express";
import { config } from "@/payments/credits/config";
import { getSpendableBalance } from "@/payments/spendable";
import { prisma } from "@/utils/prisma";

/**
 * GET /v2/accounts/:accountId/credits
 *
 * Agent-key-gated balance read for a specific accountId. The :accountId param
 * is pre-validated as a UUID by meGuard (mounted in accountsByIdRouter, Task 14).
 *
 * Response shape:
 *   200  { accountId, balance: string (BigInt serialised), allowed: boolean }
 *   404  { code: "account_not_found" }  — UUID is valid but no Account row
 *   400  { code: "invalid_account_id" } — non-UUID param (handled by meGuard)
 */
export const creditsByIdGetHandler = async (
  req: Request<{ accountId: string }>,
  res: Response,
): Promise<void> => {
  const accountId = req.params.accountId; // meGuard already validated UUID shape

  try {
    // 404 if the Account row itself doesn't exist. Spec § 4.1 perf note: this
    // adds one PK lookup per GET vs the prior check handler which skipped it.
    const account = await prisma.account.findUnique({
      where: { id: accountId },
      select: { id: true },
    });
    if (!account) {
      req.log.warn({ accountId }, "credits.read.account_not_found");
      res.status(404).json({ code: "account_not_found" });
      return;
    }

    const balance = await getSpendableBalance(accountId);
    const allowed = balance >= config.reservedMaxTurnCredits;
    req.log.info(
      { accountId, balance: balance.toString(), allowed },
      "credits.read.served",
    );
    res.status(200).json({
      accountId,
      balance: balance.toString(),
      allowed,
    });
  } catch (error) {
    req.log.error(
      {
        error,
        stack: error instanceof Error ? error.stack : undefined,
        accountId,
      },
      "credits.read.failed",
    );
    res.status(500).json({ error: "Failed to read credits balance" });
    return;
  }
};
