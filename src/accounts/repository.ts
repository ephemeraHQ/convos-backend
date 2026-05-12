import { Prisma } from "@prisma/client";
import type { AuthMethodType } from "@/accounts/auth-method-type";
import { prisma } from "@/utils/prisma";

export async function upsertAuthMethodAndAccount(args: {
  type: AuthMethodType;
  externalKey: string;
}): Promise<{ accountId: string }> {
  const findOrInsert = () =>
    prisma.$transaction(async (tx) => {
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

  try {
    return await findOrInsert();
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      // Concurrent first-login from the same wallet: the loser's tx rolled back.
      // Re-read; the winner's AuthMethod row now exists.
      return findOrInsert();
    }
    throw err;
  }
}
