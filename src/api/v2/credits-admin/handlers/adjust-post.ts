import type { Request, Response } from "express";
import {
  adjust,
  IdempotencyMismatchError,
  InsufficientBalanceError,
} from "@/payments";
import { prisma } from "@/utils/prisma";
import { writeAdminAudit } from "../audit-repository";
import { adjustBodySchema } from "../schemas/requests";

export const adjustPostHandler = async (
  req: Request<{ accountId: string }>,
  res: Response,
): Promise<void> => {
  const accountId = req.params.accountId;
  const actorEmail = res.locals.actorEmail as string;

  const parsed = adjustBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res
      .status(400)
      .json({ code: "invalid_request", details: parsed.error.errors });
    return;
  }
  const { delta, reason, idempotencyKey } = parsed.data;

  const account = await prisma.account.findUnique({
    where: { id: accountId },
    select: { id: true },
  });
  if (!account) {
    res.status(404).json({ code: "account_not_found" });
    return;
  }

  try {
    const result = await adjust({
      accountId,
      delta,
      idempotencyKey,
      note: `admin:${actorEmail} — ${reason}`,
    });

    if (!result.replayed) {
      await writeAdminAudit({
        accountId,
        actorEmail,
        action: "adjust",
        deltaCredits: BigInt(delta),
        reason,
        idempotencyKey,
      });
    }

    res.status(200).json({
      applied: true,
      replayed: result.replayed,
      balanceAfter: result.balanceAfter.toString(),
      newBalance: result.newBalance.toString(),
      ledgerId: result.ledgerId,
    });
  } catch (err) {
    if (err instanceof InsufficientBalanceError) {
      req.log.warn(
        { accountId, delta },
        "credits_admin.adjust.insufficient_balance",
      );
      res.status(402).json({ code: "insufficient_balance" });
      return;
    }
    if (err instanceof IdempotencyMismatchError) {
      req.log.warn(
        { accountId, idempotencyKey },
        "credits_admin.adjust.idempotency_mismatch",
      );
      res.status(409).json({ code: "idempotency_mismatch" });
      return;
    }
    throw err;
  }
};
