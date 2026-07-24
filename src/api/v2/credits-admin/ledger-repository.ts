import type { CreditLedger, Prisma } from "@prisma/client";
import { prisma } from "@/utils/prisma";
import { encodeAuditCursor, type RecentAuditCursor } from "./audit-repository";

export const LEDGER_PAGE_LIMIT = 50;

export type SerializedLedger = {
  id: string;
  delta: string;
  reason: string;
  grantKindId: string | null;
  note: string | null;
  idempotencyKey: string;
  balanceAfter: string | null;
  createdAt: string;
};

export const serializeLedger = (r: CreditLedger): SerializedLedger => ({
  id: r.id,
  delta: r.delta.toString(),
  reason: r.reason,
  grantKindId: r.grantKindId,
  note: r.note,
  idempotencyKey: r.idempotencyKey,
  balanceAfter: r.balanceAfter?.toString() ?? null,
  createdAt: r.createdAt.toISOString(),
});

export type LedgerFilter = {
  kind?:
    | "subscription"
    | "sub_grant"
    | "sub_forfeit"
    | "signup_bonus"
    | "daily_refill"
    | "manual";
  reason?: "consume" | "grant" | "adjust";
  from?: Date;
  to?: Date;
};

// Whole-`to`-day-inclusive upper bound. UTC accessors only — never local time —
// so the boundary does not drift by the server's timezone.
const startOfNextUtcDay = (d: Date): Date =>
  new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1));

export const listLedgerPageByAccount = async (args: {
  accountId: string;
  cursor?: RecentAuditCursor | null;
  limit?: number;
  filter?: LedgerFilter;
}): Promise<{ rows: CreditLedger[]; nextCursor: string | null }> => {
  const limit = args.limit ?? LEDGER_PAGE_LIMIT;
  const where: Prisma.CreditLedgerWhereInput = { accountId: args.accountId };
  const f = args.filter;
  if (f?.kind === "subscription") {
    where.grantKindId = { in: ["sub_grant", "sub_forfeit"] };
  } else if (f?.kind) {
    where.grantKindId = f.kind;
  }
  if (f?.reason) {
    where.reason = f.reason;
  }
  if (f?.from || f?.to) {
    where.createdAt = {
      ...(f.from ? { gte: f.from } : {}),
      ...(f.to ? { lt: startOfNextUtcDay(f.to) } : {}),
    };
  }
  if (args.cursor) {
    where.OR = [
      { createdAt: { lt: args.cursor.createdAt } },
      { createdAt: args.cursor.createdAt, id: { lt: args.cursor.id } },
    ];
  }
  const rows = await prisma.creditLedger.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
  });
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page.at(-1);
  const nextCursor = hasMore && last ? encodeAuditCursor(last) : null;
  return { rows: page, nextCursor };
};
