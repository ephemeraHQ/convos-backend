import type { AuthMethodType } from "@prisma/client";
import { prisma } from "@/utils/prisma";

export async function upsertAuthMethodAndAccount(args: {
  type: AuthMethodType;
  externalKey: string;
}): Promise<{ accountId: string }> {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.authMethod.findUnique({
      where: {
        type_externalKey: { type: args.type, externalKey: args.externalKey },
      },
    });
    if (existing) return { accountId: existing.accountId };

    const account = await tx.account.create({ data: {} });
    await tx.authMethod.create({
      data: {
        accountId: account.id,
        type: args.type,
        externalKey: args.externalKey,
      },
    });
    return { accountId: account.id };
  });
}
