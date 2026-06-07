import type { Request, Response } from "express";
import { usageQuerySchema } from "@/api/v2/accounts/schemas/credits-by-id";
import { getBucketedConsumption } from "@/payments";
import { nextUtcBucket, truncUtcBucket } from "@/payments/credits/usage-window";
import { startOfTodayUtc, ymdUtc } from "@/payments/daily-refill/utc";
import { ValidationError } from "@/utils/errors";
import { prisma } from "@/utils/prisma";

/**
 * GET /v2/accounts/:accountId/credits/usage?days=30&bucket=day
 *
 * Agent-key-gated credit-consumption time series for a specific accountId,
 * coalesced into UTC `day` / `week` / `month` buckets and zero-filled across the
 * window so the caller gets one point per bucket (oldest first). The window is
 * the last `days` days including today as the final, in-progress bucket (so
 * days=7 = today + 6 prior days). For week/month buckets the first/last bucket
 * extends to whole-bucket boundaries, so the returned span can exceed `days`
 * (e.g. days=30 on Jan 31 with bucket=month returns a single Jan 1–31 bucket).
 * :accountId is pre-validated as a UUID by meGuard.
 *
 * Response shape:
 *   200  {
 *          accountId, days, bucket,
 *          series: [{ date: "2026-05-08", consumed: 150 }, ...]
 *        }
 *   400  { code: "invalid_request", issues } — bad days/bucket query param
 *   404  { code: "account_not_found" }       — UUID is valid but no Account row
 */
export const creditsUsageGetHandler = async (
  req: Request<{ accountId: string }>,
  res: Response,
): Promise<void> => {
  const accountId = req.params.accountId; // meGuard already validated UUID shape

  const parsed = usageQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res
      .status(400)
      .json({ code: "invalid_request", issues: parsed.error.issues });
    return;
  }
  const { days, bucket } = parsed.data;

  try {
    const account = await prisma.account.findUnique({
      where: { id: accountId },
      select: { id: true },
    });
    if (!account) {
      req.log.warn({ accountId }, "credits.usage.account_not_found");
      res.status(404).json({ code: "account_not_found" });
      return;
    }

    // Rolling window: the last `days` days INCLUDING today as the final,
    // in-progress day — so days=7 is today + the 6 prior days (7 points), the
    // standard "last N days" convention for live dashboards. Align the start
    // down to a whole bucket so the first (possibly partial) bucket's total is
    // complete.
    const today = startOfTodayUtc(new Date());
    const windowStart = new Date(today);
    windowStart.setUTCDate(windowStart.getUTCDate() - (days - 1));
    const since = truncUtcBucket(windowStart, bucket);

    const rows = await getBucketedConsumption(accountId, since, bucket);
    const consumedByBucket = new Map(
      rows.map((r) => [r.bucketStart, r.consumed]),
    );

    // `since` is bucket-aligned, so iterating bucket-by-bucket while cur <= today
    // always emits the bucket containing today as the last point. Guard the
    // BigInt→number cast the same way pricing.ts/config.ts do — a bucket total
    // realistically never exceeds the safe range, but enforce it, don't assume.
    const maxSafeCredits = BigInt(Number.MAX_SAFE_INTEGER);
    const series: Array<{ date: string; consumed: number }> = [];
    for (let cur = since; cur <= today; cur = nextUtcBucket(cur, bucket)) {
      const date = ymdUtc(cur);
      const consumed = consumedByBucket.get(date) ?? 0n;
      if (consumed > maxSafeCredits) {
        throw new ValidationError(
          `usage bucket consumed exceeds safe integer range: ${consumed}`,
        );
      }
      series.push({ date, consumed: Number(consumed) });
    }

    req.log.info({ accountId, days, bucket }, "credits.usage.served");
    res.status(200).json({ accountId, days, bucket, series });
  } catch (error) {
    req.log.error(
      {
        error,
        stack: error instanceof Error ? error.stack : undefined,
        accountId,
      },
      "credits.usage.failed",
    );
    res.status(500).json({ error: "Failed to read credit usage" });
    return;
  }
};
