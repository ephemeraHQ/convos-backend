import { Prisma, type CreditLedger, type LedgerReason } from "@prisma/client";
import { prisma } from "@/utils/prisma";
import { IdempotencyMismatchError } from "../errors";
import type { HistoryCursor } from "../types";

interface ApplyDeltaInput {
  accountId: string;
  delta: bigint;
  reason: LedgerReason;
  idempotencyKey: string;
  usdCostMicros?: bigint;
  markupRate?: Prisma.Decimal | string;
  creditsPerDollar?: bigint;
  model?: string;
  requestId?: string;
  note?: string;
  grantKindId?: string;
  floorCheck?: { minBalance: bigint };
}

export interface ApplyDeltaResult {
  ledgerId: string;
  replayed: boolean;
  newBalance: bigint;
}

interface RawBalanceRow {
  balance: bigint;
}

export const getBalance = async (accountId: string): Promise<bigint> => {
  const row = await prisma.userCredits.findUnique({
    where: { accountId },
    select: { balance: true },
  });
  return row?.balance ?? 0n;
};

export const findLedgerByIdempotencyKey = async (
  accountId: string,
  idempotencyKey: string,
): Promise<CreditLedger | null> =>
  prisma.creditLedger.findUnique({
    where: {
      accountId_idempotencyKey: { accountId, idempotencyKey },
    },
  });

/**
 * Stripe-style strict replay validation: every input field must match the
 * prior ledger row, or we throw `IdempotencyMismatchError` for the first
 * mismatch. Catches caller bugs where the same idempotency key is reused
 * for a logically different operation.
 *
 * `delta` is the only field that affects balance state; mismatches on
 * other fields (model, requestId, note, ...) are detection of caller-side
 * bugs, not money safety.
 */
export const validateReplayPayload = (
  prior: CreditLedger,
  input: ApplyDeltaInput,
): void => {
  const checks: Array<[string, unknown, unknown]> = [
    ["delta", BigInt(prior.delta), input.delta],
    ["reason", prior.reason, input.reason],
    ["usdCostMicros", prior.usdCostMicros, input.usdCostMicros ?? null],
    [
      "markupRate",
      prior.markupRate?.toString() ?? null,
      input.markupRate !== undefined
        ? new Prisma.Decimal(input.markupRate.toString()).toString()
        : null,
    ],
    [
      "creditsPerDollar",
      prior.creditsPerDollar,
      input.creditsPerDollar ?? null,
    ],
    ["model", prior.model, input.model ?? null],
    ["requestId", prior.requestId, input.requestId ?? null],
    ["note", prior.note, input.note ?? null],
    ["grantKindId", prior.grantKindId, input.grantKindId ?? null],
  ];

  for (const [field, priorValue, attemptedValue] of checks) {
    if (priorValue !== attemptedValue) {
      throw new IdempotencyMismatchError(
        input.idempotencyKey,
        field,
        priorValue,
        attemptedValue,
      );
    }
  }
};

export class LedgerFloorBreachError extends Error {
  constructor(
    public readonly currentBalance: bigint,
    public readonly attempted: bigint,
    public readonly minBalance: bigint,
  ) {
    super(
      `floor breach: current=${currentBalance}, delta=${attempted}, floor=${minBalance}`,
    );
    Object.setPrototypeOf(this, LedgerFloorBreachError.prototype);
  }
}

type TxClient = Prisma.TransactionClient;

/**
 * Atomically ensure a `UserCredits` row exists for `accountId`, take a row-level
 * lock on it for the rest of the transaction, and return its current balance.
 *
 * Implementation: a single `INSERT ... ON CONFLICT DO UPDATE ... RETURNING`
 * statement. The deliberately no-op self-assignment in the `DO UPDATE SET`
 * clause (`SET "accountId" = EXCLUDED."accountId"`) is the trick — without it,
 * a plain `INSERT ... ON CONFLICT DO NOTHING` returns no rows on conflict,
 * and a follow-up SELECT would race with concurrent transactions. The
 * self-assign forces Postgres to treat the existing row as updated, which:
 *   1. Acquires the row-level lock (FOR UPDATE-equivalent for the rest of tx)
 *   2. Returns the current `balance` via RETURNING
 * all in one atomic statement.
 *
 * Why not Prisma's typed `upsert()`: it compiles to a separate SELECT then
 * INSERT/UPDATE under the hood, leaving a window where another tx can mutate
 * the row between read and write. Inline raw SQL is the only way to express
 * the atomic upsert+lock semantics here. Inputs are bound parameters, not
 * interpolated — injection-safe.
 */
const lockOrCreateBalance = async (
  tx: TxClient,
  accountId: string,
): Promise<bigint> => {
  const rows = await tx.$queryRaw<RawBalanceRow[]>`
    INSERT INTO "UserCredits" ("accountId", "balance", "createdAt", "updatedAt")
    VALUES (${accountId}::uuid, 0::bigint, now(), now())
    ON CONFLICT ("accountId") DO UPDATE
      SET "accountId" = EXCLUDED."accountId"
    RETURNING "balance"
  `;
  return rows[0]?.balance ?? 0n;
};

/**
 * Run the ledger mutation inside an existing transaction. Caller owns the tx.
 * Use this when the caller needs to perform additional reads/writes inside the
 * same transaction (e.g. tx-scoped GrantKind active-check in `grant()`).
 *
 * Does NOT handle the P2002 idempotent-replay path — that lives in `applyDelta`
 * because replay requires a fresh top-level read after the inner tx aborted.
 */
export const applyDeltaWithTx = async (
  tx: TxClient,
  input: ApplyDeltaInput,
): Promise<ApplyDeltaResult> => {
  const before = await lockOrCreateBalance(tx, input.accountId);
  const after = before + input.delta;

  if (input.floorCheck && after < input.floorCheck.minBalance) {
    throw new LedgerFloorBreachError(
      before,
      input.delta,
      input.floorCheck.minBalance,
    );
  }

  await tx.userCredits.update({
    where: { accountId: input.accountId },
    data: { balance: after },
  });

  const created = await tx.creditLedger.create({
    data: {
      accountId: input.accountId,
      delta: input.delta,
      reason: input.reason,
      idempotencyKey: input.idempotencyKey,
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

  return { ledgerId: created.id, replayed: false, newBalance: after };
};

export const applyDelta = async (
  input: ApplyDeltaInput,
): Promise<ApplyDeltaResult> => {
  try {
    return await prisma.$transaction((tx) => applyDeltaWithTx(tx, input));
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      const prior = await findLedgerByIdempotencyKey(
        input.accountId,
        input.idempotencyKey,
      );
      if (prior) {
        validateReplayPayload(prior, input);
        // Replay path: read current balance post-fact. Not the lock-window
        // exact value, but accurate at read time — same race window as any
        // independent getBalance call.
        const newBalance = await getBalance(input.accountId);
        return { ledgerId: prior.id, replayed: true, newBalance };
      }
    }
    throw err;
  }
};

export const getHistory = async (
  accountId: string,
  limit = 50,
  cursor?: HistoryCursor,
): Promise<CreditLedger[]> => {
  return prisma.creditLedger.findMany({
    where: {
      accountId,
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
