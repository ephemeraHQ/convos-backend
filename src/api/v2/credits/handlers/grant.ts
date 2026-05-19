import { Prisma } from "@prisma/client";
import type { Request, Response } from "express";
import { grant as grantCredits } from "@/payments";
import { IdempotencyMismatchError } from "@/payments/errors";
import { isAccountIdFkViolation } from "../fk-violation";
import { grantRequestSchema } from "../schemas";

export async function grant(req: Request, res: Response): Promise<void> {
  const { accountId, credits, grantKindId, idempotencyKey, note } =
    grantRequestSchema.parse(req.body);

  try {
    const result = await grantCredits({
      accountId,
      credits,
      kind: grantKindId,
      idempotencyKey,
      note,
    });
    req.log.info(
      {
        accountId,
        granted: result.granted,
        replayed: result.replayed,
        grantKindId,
      },
      result.replayed ? "credits.grant.replayed" : "credits.grant.accepted",
    );
    res.status(200).json({
      granted: result.granted,
      balance: result.newBalance.toString(),
      replayed: result.replayed,
    });
  } catch (err) {
    if (err instanceof IdempotencyMismatchError) {
      req.log.info(
        { accountId, idempotencyKey },
        "credits.grant.idempotency_mismatch",
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
