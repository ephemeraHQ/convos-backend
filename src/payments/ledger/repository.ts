import { type CreditLedger, LedgerReason, Prisma } from "@prisma/client";
import { prisma } from "@/utils/prisma";
import type { HistoryCursor } from "../types";

interface ApplyDeltaInput {
  inboxId: string;
  delta: number;
  reason: LedgerReason;
  idempotencyKey: string;
  usdCostMicros?: bigint;
  markupRate?: Prisma.Decimal | string;
  creditsPerDollar?: number;
  model?: string;
  requestId?: string;
  note?: string;
  grantKindId?: string;
  floorCheck?: { minBalance: bigint };
}

export interface ApplyDeltaResult {
  balanceAfter: bigint;
  ledgerId: string;
  replayed: boolean;
}

interface RawBalanceRow {
  balance: bigint;
}

export const getBalance = async (inboxId: string): Promise<bigint> => {
  const row = await prisma.userCredits.findUnique({
    where: { inboxId },
    select: { balance: true },
  });
  return row?.balance ?? 0n;
};

export const findLedgerByIdempotencyKey = async (
  inboxId: string,
  idempotencyKey: string,
): Promise<CreditLedger | null> =>
  prisma.creditLedger.findUnique({
    where: {
      inboxId_idempotencyKey: { inboxId, idempotencyKey },
    },
  });

export class LedgerFloorBreachError extends Error {
  constructor(
    public readonly currentBalance: bigint,
    public readonly attempted: number,
    public readonly minBalance: bigint,
  ) {
    super(
      `floor breach: current=${currentBalance}, delta=${attempted}, floor=${minBalance}`,
    );
    Object.setPrototypeOf(this, LedgerFloorBreachError.prototype);
  }
}

export const applyDelta = async (
  input: ApplyDeltaInput,
): Promise<ApplyDeltaResult> => {
  try {
    return await prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<RawBalanceRow[]>`
        INSERT INTO "UserCredits" ("inboxId", "balance", "createdAt", "updatedAt")
        VALUES (${input.inboxId}, 0::bigint, now(), now())
        ON CONFLICT ("inboxId") DO UPDATE
          SET "inboxId" = EXCLUDED."inboxId"
        RETURNING "balance"
      `;
      const before = rows[0]?.balance ?? 0n;
      const after = before + BigInt(input.delta);

      if (input.floorCheck && after < input.floorCheck.minBalance) {
        throw new LedgerFloorBreachError(
          before,
          input.delta,
          input.floorCheck.minBalance,
        );
      }

      await tx.userCredits.update({
        where: { inboxId: input.inboxId },
        data: { balance: after },
      });

      const created = await tx.creditLedger.create({
        data: {
          inboxId: input.inboxId,
          delta: input.delta,
          reason: input.reason,
          idempotencyKey: input.idempotencyKey,
          balanceAfter: after,
          usdCostMicros: input.usdCostMicros ?? null,
          markupRate:
            input.markupRate !== undefined
              ? new Prisma.Decimal(input.markupRate.toString())
              : null,
          creditsPerDollar: input.creditsPerDollar ?? null,
          model: input.model ?? null,
          requestId: input.requestId ?? null,
          note: input.note ?? null,
          grantKindId: input.grantKindId ?? null,
        },
      });

      return { balanceAfter: after, ledgerId: created.id, replayed: false };
    });
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      const prior = await findLedgerByIdempotencyKey(
        input.inboxId,
        input.idempotencyKey,
      );
      if (prior) {
        return {
          balanceAfter: prior.balanceAfter,
          ledgerId: prior.id,
          replayed: true,
        };
      }
    }
    throw err;
  }
};

export const getHistory = async (
  inboxId: string,
  limit = 50,
  cursor?: HistoryCursor,
): Promise<CreditLedger[]> => {
  return prisma.creditLedger.findMany({
    where: {
      inboxId,
      ...(cursor
        ? {
            OR: [
              { createdAt: { lt: cursor.createdAt } },
              { createdAt: cursor.createdAt, id: { lt: cursor.id } },
            ],
          }
        : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit,
  });
};
