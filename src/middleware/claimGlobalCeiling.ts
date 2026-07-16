import type { NextFunction, Request, Response } from "express";
import { prisma } from "@/utils/prisma";

/**
 * Global claims-per-hour ceiling, backed by the shared RateLimitCounter
 * table so the limit holds across every replica (an in-process store would
 * multiply it by the replica count).
 *
 * Security-ceiling semantics, so it fails CLOSED: a counter-store error
 * returns 503 rather than waving the request through — the ceiling is the
 * batch-theft tripwire and must not silently disappear when the table is
 * missing or the query fails. Window identity derives from DATABASE time
 * (now() truncated to the window), so replicas with skewed app clocks
 * cannot split the counter across two windows at a boundary.
 */

const COUNTER_KEY = "subscription_claim_global";

export type ClaimCeilingIncrement = (
  windowSeconds: number,
) => Promise<{ count: number }>;

const defaultIncrement: ClaimCeilingIncrement = async (windowSeconds) => {
  const rows = await prisma.$queryRaw<Array<{ count: number }>>`
    INSERT INTO "RateLimitCounter" ("key", "windowStart", "count", "updatedAt")
    VALUES (
      ${COUNTER_KEY},
      to_timestamp(floor(extract(epoch FROM now()) / ${windowSeconds}) * ${windowSeconds}),
      1,
      now()
    )
    ON CONFLICT ("key", "windowStart")
    DO UPDATE SET "count" = "RateLimitCounter"."count" + 1, "updatedAt" = now()
    RETURNING "count"
  `;
  const first = rows.at(0);
  if (!first) {
    throw new Error("claim ceiling increment returned no row");
  }
  const count = first.count;
  // Opportunistic cleanup of expired windows (cheap at this volume).
  void prisma.rateLimitCounter
    .deleteMany({
      where: {
        key: COUNTER_KEY,
        windowStart: {
          lt: new Date(Date.now() - 2 * windowSeconds * 1000),
        },
      },
    })
    .catch(() => undefined);
  return { count };
};

let incrementOverride: ClaimCeilingIncrement | null = null;

/** Test seam: inject an increment implementation; null restores default. */
export const __setClaimCeilingIncrementForTests = (
  increment: ClaimCeilingIncrement | null,
): void => {
  incrementOverride = increment;
};

export const makeClaimGlobalCeiling = (opts: {
  windowSeconds: number;
  limit: number;
}) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const increment = incrementOverride ?? defaultIncrement;
      const { count } = await increment(opts.windowSeconds);
      if (count > opts.limit) {
        req.log.error(
          { count, limit: opts.limit },
          "subscription.claim.global_ceiling_hit",
        );
        res.status(429).json({
          error: "Too many subscription claim requests, please try again later",
        });
        return;
      }
      next();
    } catch (err) {
      req.log.error({ err }, "subscription.claim.global_ceiling_unavailable");
      res.status(503).json({
        error: "Subscription claims are temporarily unavailable",
      });
    }
  };
};
