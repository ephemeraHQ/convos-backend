import type { Request, Response } from "express";
import { accountIdSchema } from "@/utils/account-id";
import { prisma } from "@/utils/prisma";
import { searchQuerySchema } from "../schemas/requests";

export const searchGetHandler = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const parsed = searchQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res
      .status(400)
      .json({ code: "invalid_request", details: parsed.error.errors });
    return;
  }
  const { key, value } = parsed.data;

  // When key is omitted (single smart search box) infer the lane: a UUID is an
  // accountId, anything else is treated as a SIWE wallet externalKey. UUID and
  // 0x-wallet shapes never collide, so this is unambiguous.
  const isAccountId = accountIdSchema.safeParse(value).success;
  const lane = key ?? (isAccountId ? "accountId" : "wallet");

  if (lane === "accountId") {
    if (!isAccountId) {
      res.status(200).json({ accountId: null });
      return;
    }
    const account = await prisma.account.findUnique({
      where: { id: value },
      select: { id: true },
    });
    res.status(200).json({ accountId: account?.id ?? null });
    return;
  }

  // Wallet lane. externalKey is matched exactly (current behavior); do NOT add a
  // blind .toLowerCase() — SIWE externalKey storage case is unverified and a
  // lowercase would regress a checksummed row.
  const authMethod = await prisma.authMethod.findUnique({
    where: { type_externalKey: { type: "SIWE", externalKey: value } },
    select: { accountId: true },
  });
  res.status(200).json({ accountId: authMethod?.accountId ?? null });
};
