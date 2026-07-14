import type { CreditLedger } from "@prisma/client";
import type { Request, Response } from "express";
import { getBalance, getBucketedConsumption } from "@/payments";
import { sumPeriodConsumes } from "@/payments/spendable";
import { findCurrentByAccountId } from "@/subscriptions/repository";
import {
  effectiveSubscriptionStatus,
  ENTITLED_SUBSCRIPTION_STATUSES,
} from "@/subscriptions/status";
import { prisma } from "@/utils/prisma";

const DAY_MS = 24 * 60 * 60 * 1000;
const LEDGER_LIMIT = 50;
const REFILL_LIMIT = 20;
const USAGE_WINDOW_DAYS = 30;

const serializeLedger = (r: CreditLedger) => ({
  id: r.id,
  delta: r.delta.toString(),
  reason: r.reason,
  grantKindId: r.grantKindId,
  note: r.note,
  idempotencyKey: r.idempotencyKey,
  balanceAfter: r.balanceAfter?.toString() ?? null,
  createdAt: r.createdAt.toISOString(),
});

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
    currentPeriodStart: string;
    currentPeriodEnd: string;
    environment: string | null;
    willRenew: boolean;
    isInTrial: boolean;
  } | null = null;
  let periodConsumesCredits = 0;

  if (subscription) {
    const effectiveStatus = effectiveSubscriptionStatus(subscription, now);
    const isEntitled = ENTITLED_SUBSCRIPTION_STATUSES.includes(effectiveStatus);
    if (isEntitled) {
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
      currentPeriodStart: subscription.currentPeriodStart.toISOString(),
      currentPeriodEnd: subscription.currentPeriodEnd.toISOString(),
      environment: subscription.environment ?? null,
      willRenew: subscription.willRenew,
      isInTrial: subscription.isInTrial,
    };
  }

  const [balance, ledgerRows, refillRows, usage] = await Promise.all([
    getBalance(accountId),
    prisma.creditLedger.findMany({
      where: { accountId },
      orderBy: { createdAt: "desc" },
      take: LEDGER_LIMIT,
    }),
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
    ledger: ledgerRows.map(serializeLedger),
    dailyRefills: refillRows.map(serializeLedger),
    usageDaily: usage.map((u) => ({
      bucketStart: u.bucketStart,
      consumed: u.consumed.toString(),
    })),
  });
};
