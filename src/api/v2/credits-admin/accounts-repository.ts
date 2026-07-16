import { Prisma } from "@prisma/client";
import { prisma } from "@/utils/prisma";

const dirSql = (dir: "asc" | "desc"): Prisma.Sql =>
  dir === "asc" ? Prisma.sql`ASC` : Prisma.sql`DESC`;

export const ACCOUNTS_LIST_LIMIT = 50;

export type BalanceRow = {
  accountId: string;
  balance: bigint;
  wallet: string | null;
  lastConsumeAt: Date | null;
};

export type BrokenRow = {
  accountId: string;
  balance: bigint;
  tier: string;
  effectiveStatus: string;
  currentPeriodEnd: Date;
};

export type GrantKindRow = {
  accountId: string;
  balance: bigint;
  latestGrantAt: Date;
};

/** `lastConsumeAt` is null for accounts that have never consumed. */
export type ActivityRow = {
  accountId: string;
  balance: bigint;
  lastConsumeAt: Date | null;
};

export type Page<T> = { rows: T[]; hasMore: boolean };

const page = <T>(rows: T[], limit: number): Page<T> => ({
  rows: rows.slice(0, limit),
  hasMore: rows.length > limit,
});

export const listByBalance = async (args: {
  min?: number | null;
  max?: number | null;
  sort?: "asc" | "desc";
  sortDir?: "asc" | "desc";
  page?: number;
  limit?: number;
}): Promise<Page<BalanceRow>> => {
  const limit = args.limit ?? ACCOUNTS_LIST_LIMIT;
  const skip = (args.page ?? 0) * limit;
  const d = dirSql(args.sortDir ?? args.sort ?? "desc");
  const min = args.min != null ? BigInt(args.min) : null;
  const max = args.max != null ? BigInt(args.max) : null;
  const rows = await prisma.$queryRaw<BalanceRow[]>`
    SELECT uc."accountId", uc.balance,
      (SELECT am."externalKey" FROM "AuthMethod" am
       WHERE am."accountId" = uc."accountId" AND am.type = 'SIWE'
       ORDER BY am."addedAt" DESC LIMIT 1) AS wallet,
      (SELECT MAX(cl."createdAt") FROM "CreditLedger" cl
       WHERE cl."accountId" = uc."accountId" AND cl.reason = 'consume')
       AS "lastConsumeAt"
    FROM "UserCredits" uc
    WHERE (${min}::bigint IS NULL OR uc.balance >= ${min}::bigint)
      AND (${max}::bigint IS NULL OR uc.balance <= ${max}::bigint)
    ORDER BY uc.balance ${d}, uc."accountId" ASC
    LIMIT ${limit + 1} OFFSET ${skip}
  `;
  return page(
    rows.map((r) => ({
      accountId: r.accountId,
      balance: r.balance,
      wallet: r.wallet,
      lastConsumeAt: r.lastConsumeAt,
    })),
    limit,
  );
};

export const listBrokenSubscribers = async (args: {
  maxBalance?: number;
  sortBy?: "balance" | "currentPeriodEnd" | "tier";
  sortDir?: "asc" | "desc";
  page?: number;
  limit?: number;
}): Promise<Page<BrokenRow>> => {
  const limit = args.limit ?? ACCOUNTS_LIST_LIMIT;
  const skip = (args.page ?? 0) * limit;
  const maxBalance = BigInt(args.maxBalance ?? 0);
  const d = dirSql(args.sortDir ?? "asc");
  const orderBy =
    args.sortBy === "currentPeriodEnd"
      ? Prisma.sql`ORDER BY sub."currentPeriodEnd" ${d}, uc."accountId"`
      : args.sortBy === "tier"
        ? Prisma.sql`ORDER BY sub.tier ${d}, uc."accountId"`
        : Prisma.sql`ORDER BY uc.balance ${d}, uc."accountId"`;
  const rows = await prisma.$queryRaw<BrokenRow[]>`
    SELECT uc."accountId", uc.balance,
           sub.tier, sub.status AS "effectiveStatus", sub."currentPeriodEnd"
    FROM "UserCredits" uc
    JOIN LATERAL (
      SELECT s.tier, s.status, s."currentPeriodEnd"
      FROM "Subscription" s
      WHERE s."accountId" = uc."accountId"
        AND (
          s.status = 'billingRetry'
          OR (s.status IN ('active','trial') AND s."currentPeriodEnd" > now())
          OR (s.status = 'grace' AND COALESCE(s."gracePeriodEnd", s."currentPeriodEnd") > now())
        )
      ORDER BY s."currentPeriodEnd" DESC
      LIMIT 1
    ) sub ON true
    WHERE uc.balance <= ${maxBalance}
    ${orderBy}
    LIMIT ${limit + 1} OFFSET ${skip}
  `;
  return page(
    rows.map((r) => ({
      accountId: r.accountId,
      balance: r.balance,
      tier: r.tier,
      effectiveStatus: r.effectiveStatus,
      currentPeriodEnd: r.currentPeriodEnd,
    })),
    limit,
  );
};

export const listByGrantKind = async (args: {
  kind: string;
  sortBy?: "latestGrantAt" | "balance";
  sortDir?: "asc" | "desc";
  page?: number;
  limit?: number;
}): Promise<Page<GrantKindRow>> => {
  const limit = args.limit ?? ACCOUNTS_LIST_LIMIT;
  const skip = (args.page ?? 0) * limit;
  const d = dirSql(args.sortDir ?? "desc");
  const orderBy =
    args.sortBy === "balance"
      ? Prisma.sql`ORDER BY uc.balance ${d}, cl."accountId"`
      : Prisma.sql`ORDER BY "latestGrantAt" ${d}, cl."accountId"`;
  const rows = await prisma.$queryRaw<GrantKindRow[]>`
    SELECT cl."accountId", uc.balance, MAX(cl."createdAt") AS "latestGrantAt"
    FROM "CreditLedger" cl
    JOIN "UserCredits" uc ON uc."accountId" = cl."accountId"
    WHERE cl."grantKindId" = ${args.kind}
    GROUP BY cl."accountId", uc.balance
    ${orderBy}
    LIMIT ${limit + 1} OFFSET ${skip}
  `;
  return page(
    rows.map((r) => ({
      accountId: r.accountId,
      balance: r.balance,
      latestGrantAt: r.latestGrantAt,
    })),
    limit,
  );
};

export const listByActivity = async (args: {
  state: "active" | "dormant";
  days?: number;
  sortBy?: "lastConsumeAt" | "balance";
  sortDir?: "asc" | "desc";
  page?: number;
  limit?: number;
}): Promise<Page<ActivityRow>> => {
  const limit = args.limit ?? ACCOUNTS_LIST_LIMIT;
  const skip = (args.page ?? 0) * limit;
  const days = args.days ?? 30;
  const d = dirSql(args.sortDir ?? "desc");
  // Tiebreaker must be the output-column "accountId", not uc."accountId": the
  // active branch groups by cl."accountId" and would 42803 on uc."accountId".
  const orderBy =
    args.sortBy === "balance"
      ? Prisma.sql`ORDER BY uc.balance ${d}, "accountId"`
      : Prisma.sql`ORDER BY "lastConsumeAt" ${d} NULLS LAST, "accountId"`;
  const rows =
    args.state === "active"
      ? await prisma.$queryRaw<
          { accountId: string; balance: bigint; lastConsumeAt: Date }[]
        >`
          SELECT cl."accountId", uc.balance, MAX(cl."createdAt") AS "lastConsumeAt"
          FROM "CreditLedger" cl
          JOIN "UserCredits" uc ON uc."accountId" = cl."accountId"
          WHERE cl.reason = 'consume'
            AND cl."createdAt" >= now() - (${days} * interval '1 day')
          GROUP BY cl."accountId", uc.balance
          ${orderBy}
          LIMIT ${limit + 1} OFFSET ${skip}
        `
      : await prisma.$queryRaw<ActivityRow[]>`
          SELECT uc."accountId", uc.balance,
            (SELECT MAX(cl2."createdAt") FROM "CreditLedger" cl2
             WHERE cl2."accountId" = uc."accountId" AND cl2.reason = 'consume') AS "lastConsumeAt"
          FROM "UserCredits" uc
          WHERE NOT EXISTS (
            SELECT 1 FROM "CreditLedger" cl
            WHERE cl."accountId" = uc."accountId" AND cl.reason = 'consume'
              AND cl."createdAt" >= now() - (${days} * interval '1 day')
          )
          ${orderBy}
          LIMIT ${limit + 1} OFFSET ${skip}
        `;
  return page(
    rows.map((r) => ({
      accountId: r.accountId,
      balance: r.balance,
      lastConsumeAt: r.lastConsumeAt,
    })),
    limit,
  );
};
