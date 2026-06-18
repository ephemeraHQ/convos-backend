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

  if (key === "accountId") {
    if (!accountIdSchema.safeParse(value).success) {
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

  const authMethod = await prisma.authMethod.findUnique({
    where: { type_externalKey: { type: "SIWE", externalKey: value } },
    select: { accountId: true },
  });
  res.status(200).json({ accountId: authMethod?.accountId ?? null });
};
