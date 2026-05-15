import type { Request, Response } from "express";
import { getBalance } from "@/payments";
import { isAllowedFromBalance } from "@/payments/credits/policy";
import { checkRequestSchema } from "../schemas";

export async function check(req: Request, res: Response): Promise<void> {
  const parsed = checkRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "Validation Error",
      details: parsed.error.flatten(),
    });
    return;
  }
  const { accountId } = parsed.data;
  const balance = await getBalance(accountId);
  const allowed = isAllowedFromBalance(balance);
  res.status(200).json({ allowed, balance: balance.toString() });
}
