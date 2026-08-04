import type { Request, Response } from "express";
import { getBalance, getBucketedConsumption } from "@/payments";
import { sumPeriodConsumes } from "@/payments/spendable";
import { findCurrentByAccountId } from "@/subscriptions/repository";
import {
  effectiveSubscriptionStatus,
  effectiveSubscriptionStatusForDisplay,
  ENTITLED_SUBSCRIPTION_STATUSES,
} from "@/subscriptions/status";
import { tierGrant } from "@/subscriptions/tier-config";
import { requireSubscriptionTier } from "@/subscriptions/tiers";
import { prisma } from "@/utils/prisma";
import { listLedgerPageByAccount, serializeLedger } from "../ledger-repository";

const DAY_MS = 24 * 60 * 60 * 1000;
const REFILL_LIMIT = 20;
const USAGE_WINDOW_DAYS = 30;

export const accountViewGetHandler = async (
  req: Request<{ accountId: string }>,
  res: Response,
): Promise<void> => {
  const accountId = req.params.accountId;

  const account = await prisma.account.findUnique({
    where: { id: accountId },
    select: { id: true, createdAt: true },
  });
  if (!account) {
    req.log.warn({ accountId }, "credits_admin.view.account_not_found");
    res.status(404).json({ code: "account_not_found" });
    return;
  }

  const now = new Date();
  const subscription = await findCurrentByAccountId(accountId);

  let subView: {
    tier: string;
    storedStatus: string;
    effectiveStatus: string;
    isEntitled: boolean;
    // Display/framing entitlement (what GET /credits and the iOS plan badge
    // use): keeps an auto-renewing sub entitled while a late/dropped renewal
    // webhook leaves `currentPeriodEnd` in the recent past (CON-799). Superset
    // of the strict money `isEntitled` above, which gates the grant backfill.
    displayEffectiveStatus: string;
    displayIsEntitled: boolean;
    currentPeriodStart: string;
    currentPeriodEnd: string;
    environment: string | null;
    willRenew: boolean;
    isInTrial: boolean;
    perPeriodCredits: number;
  } | null = null;
  let periodConsumesCredits = 0;

  if (subscription) {
    const effectiveStatus = effectiveSubscriptionStatus(subscription, now);
    const isEntitled = ENTITLED_SUBSCRIPTION_STATUSES.includes(effectiveStatus);
    const displayEffectiveStatus = effectiveSubscriptionStatusForDisplay(
      subscription,
      now,
    );
    const displayIsEntitled = ENTITLED_SUBSCRIPTION_STATUSES.includes(
      displayEffectiveStatus,
    );
    // Show period usage whenever the account is framed as entitled to anyone
    // (display superset) so the admin figures match what the user sees.
    if (displayIsEntitled) {
      periodConsumesCredits = await sumPeriodConsumes(
        accountId,
        subscription.currentPeriodStart,
      );
    }
    subView = {
      tier: subscription.tier,
      storedStatus: subscription.status,
      effectiveStatus,
      isEntitled,
      displayEffectiveStatus,
      displayIsEntitled,
      currentPeriodStart: subscription.currentPeriodStart.toISOString(),
      currentPeriodEnd: subscription.currentPeriodEnd.toISOString(),
      environment: subscription.environment ?? null,
      willRenew: subscription.willRenew,
      isInTrial: subscription.isInTrial,
      perPeriodCredits: tierGrant(
        requireSubscriptionTier(subscription.tier),
        subscription.period,
      ).perPeriod,
    };
  }

  const [balance, ledgerPage, refillRows, usage] = await Promise.all([
    getBalance(accountId),
    listLedgerPageByAccount({ accountId }),
    prisma.creditLedger.findMany({
      where: { accountId, grantKindId: "daily_refill" },
      orderBy: { createdAt: "desc" },
      take: REFILL_LIMIT,
    }),
    getBucketedConsumption(
      accountId,
      new Date(now.getTime() - USAGE_WINDOW_DAYS * DAY_MS),
      "day",
    ),
  ]);

  res.status(200).json({
    accountId,
    accountCreatedAt: account.createdAt.toISOString(),
    subscription: subView,
    isEntitled: subView?.isEntitled ?? false,
    balanceCredits: balance.toString(),
    periodConsumesCredits,
    ledger: ledgerPage.rows.map(serializeLedger),
    ledgerNextCursor: ledgerPage.nextCursor,
    dailyRefills: refillRows.map(serializeLedger),
    usageDaily: usage.map((u) => ({
      bucketStart: u.bucketStart,
      consumed: u.consumed.toString(),
    })),
  });
};
