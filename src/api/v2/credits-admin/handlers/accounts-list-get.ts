import type { Request, Response } from "express";
import {
  listBrokenSubscribers,
  listByActivity,
  listByBalance,
  listByGrantKind,
} from "../accounts-repository";
import { accountsListQuerySchema } from "../schemas/requests";

const base = (r: { accountId: string; balance: bigint }) => ({
  accountId: r.accountId,
  balanceCredits: r.balance.toString(),
});

export const accountsListGetHandler = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const parsed = accountsListQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res
      .status(400)
      .json({ code: "invalid_request", details: parsed.error.errors });
    return;
  }
  const q = parsed.data;
  const listed = await (async () => {
    switch (q.mode) {
      case "balance": {
        const p = await listByBalance(q);
        return { hasMore: p.hasMore, rows: p.rows.map(base) };
      }
      case "broken": {
        const p = await listBrokenSubscribers(q);
        return {
          hasMore: p.hasMore,
          rows: p.rows.map((r) => ({
            ...base(r),
            tier: r.tier,
            effectiveStatus: r.effectiveStatus,
            currentPeriodEnd: r.currentPeriodEnd.toISOString(),
          })),
        };
      }
      case "grantKind": {
        const p = await listByGrantKind(q);
        return {
          hasMore: p.hasMore,
          rows: p.rows.map((r) => ({
            ...base(r),
            latestGrantAt: r.latestGrantAt.toISOString(),
          })),
        };
      }
      case "activity": {
        const p = await listByActivity(q);
        return {
          hasMore: p.hasMore,
          rows: p.rows.map((r) => ({
            ...base(r),
            lastConsumeAt: r.lastConsumeAt?.toISOString() ?? null,
          })),
        };
      }
    }
  })();
  res.status(200).json({
    mode: q.mode,
    page: q.page,
    hasMore: listed.hasMore,
    rows: listed.rows,
  });
};
