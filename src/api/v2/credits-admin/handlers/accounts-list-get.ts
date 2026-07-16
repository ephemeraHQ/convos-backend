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
        return {
          hasMore: p.hasMore,
          rows: p.rows.map((r) => ({
            ...base(r),
            wallet: r.wallet,
            lastConsumeAt: r.lastConsumeAt?.toISOString() ?? null,
          })),
        };
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
      default: {
        // Forcing function: a new mode in accountsListQuerySchema that isn't
        // handled above narrows to that mode here instead of `never`, so this
        // assignment fails to compile. Load-bearing — do not delete.
        const _exhaustive: never = q;
        void _exhaustive;
        throw new Error("unhandled accounts-list mode");
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
