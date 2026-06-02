import { LedgerReason, type Prisma } from "@prisma/client";
import { applyDeltaWithTx } from "./ledger/repository";

export const grantSignupBonusWithTx = (
  tx: Prisma.TransactionClient,
  accountId: string,
  credits: number,
) =>
  applyDeltaWithTx(tx, {
    accountId,
    delta: BigInt(credits),
    reason: LedgerReason.grant,
    idempotencyKey: `signup_bonus_${accountId}`,
    scope: "grant",
    grantKindId: "signup_bonus",
    note: "Signup bonus",
  });
