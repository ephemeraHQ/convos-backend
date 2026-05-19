import type { Request, Response } from "express";
import {
  findCurrentByAccountId,
  serializeUserSubscription,
} from "@/subscriptions/repository";

export async function subscriptionGetHandler(req: Request, res: Response) {
  const accountId = res.locals.accountId as string;

  try {
    const subscription = await findCurrentByAccountId(accountId);
    if (!subscription) {
      res.status(204).end();
      return;
    }
    res.status(200).json(serializeUserSubscription(subscription));
    return;
  } catch (error) {
    req.log.error(
      { error, stack: error instanceof Error ? error.stack : undefined },
      "Failed to load subscription for account",
    );
    res.status(500).json({ error: "Failed to load subscription" });
    return;
  }
}
