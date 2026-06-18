import type { Request, Response } from "express";
import { grant, IdempotencyMismatchError } from "@/payments";
import { prisma } from "@/utils/prisma";
import { writeAdminAudit } from "../audit-repository";
import { grantBodySchema } from "../schemas/requests";

export const grantPostHandler = async (
  req: Request<{ accountId: string }>,
  res: Response,
): Promise<void> => {
  const accountId = req.params.accountId;
  const actorEmail = res.locals.actorEmail as string;

  const parsed = grantBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res
      .status(400)
      .json({ code: "invalid_request", details: parsed.error.errors });
    return;
  }
  const { credits, reason, idempotencyKey } = parsed.data;

  const account = await prisma.account.findUnique({
    where: { id: accountId },
    select: { id: true },
  });
  if (!account) {
    res.status(404).json({ code: "account_not_found" });
    return;
  }

  try {
    const result = await grant({
      accountId,
      credits,
      kind: "manual",
      idempotencyKey,
      note: `admin:${actorEmail} — ${reason}`,
      requestId: idempotencyKey,
    });

    await writeAdminAudit({
      accountId,
      actorEmail,
      action: "grant",
      deltaCredits: BigInt(credits),
      reason,
      idempotencyKey,
    });

    res.status(200).json({
      applied: true,
      replayed: result.replayed,
      granted: result.granted,
      balanceAfter: result.balanceAfter.toString(),
      newBalance: result.newBalance.toString(),
      ledgerId: result.ledgerId,
    });
  } catch (err) {
    if (err instanceof IdempotencyMismatchError) {
      req.log.warn(
        { accountId, idempotencyKey },
        "credits_admin.grant.idempotency_mismatch",
      );
      res.status(409).json({ code: "idempotency_mismatch" });
      return;
    }
    throw err;
  }
};
