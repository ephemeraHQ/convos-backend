import type { Prisma } from "@prisma/client";
import { prisma } from "@/utils/prisma";

export const ACCOUNTS_LIST_LIMIT = 50;

export type AccountRow = {
  accountId: string;
  balance: bigint;
  tier?: string;
  effectiveStatus?: string;
  currentPeriodEnd?: Date | null;
  latestGrantAt?: Date | null;
  lastConsumeAt?: Date | null;
};

type Page = { rows: AccountRow[]; hasMore: boolean };

const page = (rows: AccountRow[], limit: number): Page => ({
  rows: rows.slice(0, limit),
  hasMore: rows.length > limit,
});

export const listByBalance = async (args: {
  min?: number | null;
  max?: number | null;
  sort?: "asc" | "desc";
  page?: number;
  limit?: number;
}): Promise<Page> => {
  const limit = args.limit ?? ACCOUNTS_LIST_LIMIT;
  const skip = (args.page ?? 0) * limit;
  const balance: Prisma.BigIntFilter = {};
  if (args.min != null) balance.gte = BigInt(args.min);
  if (args.max != null) balance.lte = BigInt(args.max);
  const rows = await prisma.userCredits.findMany({
    where: Object.keys(balance).length ? { balance } : {},
    orderBy: [{ balance: args.sort ?? "desc" }, { accountId: "asc" }],
    take: limit + 1,
    skip,
    select: { accountId: true, balance: true },
  });
  return page(
    rows.map((r) => ({ accountId: r.accountId, balance: r.balance })),
    limit,
  );
};

export const listBrokenSubscribers = async (args: {
  maxBalance?: number;
  page?: number;
  limit?: number;
}): Promise<Page> => {
  const limit = args.limit ?? ACCOUNTS_LIST_LIMIT;
  const skip = (args.page ?? 0) * limit;
  const maxBalance = BigInt(args.maxBalance ?? 0);
  const rows = await prisma.$queryRaw<
    {
      accountId: string;
      balance: bigint;
      tier: string;
      effectiveStatus: string;
      currentPeriodEnd: Date;
    }[]
  >`
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
    ORDER BY uc.balance ASC, uc."accountId"
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
  page?: number;
  limit?: number;
}): Promise<Page> => {
  const limit = args.limit ?? ACCOUNTS_LIST_LIMIT;
  const skip = (args.page ?? 0) * limit;
  const rows = await prisma.$queryRaw<
    { accountId: string; balance: bigint; latestGrantAt: Date }[]
  >`
    SELECT cl."accountId", uc.balance, MAX(cl."createdAt") AS "latestGrantAt"
    FROM "CreditLedger" cl
    JOIN "UserCredits" uc ON uc."accountId" = cl."accountId"
    WHERE cl."grantKindId" = ${args.kind}
    GROUP BY cl."accountId", uc.balance
    ORDER BY "latestGrantAt" DESC, cl."accountId"
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
  page?: number;
  limit?: number;
}): Promise<Page> => {
  const limit = args.limit ?? ACCOUNTS_LIST_LIMIT;
  const skip = (args.page ?? 0) * limit;
  const days = args.days ?? 30;
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
          ORDER BY "lastConsumeAt" DESC, cl."accountId"
          LIMIT ${limit + 1} OFFSET ${skip}
        `
      : await prisma.$queryRaw<
          { accountId: string; balance: bigint; lastConsumeAt: Date | null }[]
        >`
          SELECT uc."accountId", uc.balance,
            (SELECT MAX(cl2."createdAt") FROM "CreditLedger" cl2
             WHERE cl2."accountId" = uc."accountId" AND cl2.reason = 'consume') AS "lastConsumeAt"
          FROM "UserCredits" uc
          WHERE NOT EXISTS (
            SELECT 1 FROM "CreditLedger" cl
            WHERE cl."accountId" = uc."accountId" AND cl.reason = 'consume'
              AND cl."createdAt" >= now() - (${days} * interval '1 day')
          )
          ORDER BY "lastConsumeAt" DESC NULLS LAST, uc."accountId"
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
