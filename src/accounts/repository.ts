import { Prisma } from "@prisma/client";
import type { AuthMethodType } from "@/accounts/auth-method-type";
import { hashDeletedIdentity } from "@/accounts/deletion/identity-hash";
import { prisma } from "@/utils/prisma";

/**
 * Thrown when the auto-provisioning upsert finds the identity behind the
 * permanent deletion barrier. The mint handler maps this to the terminal
 * 410 identity_deleted response.
 */
export class IdentityBarredError extends Error {
  constructor(
    public readonly type: AuthMethodType,
    public readonly externalKey: string,
  ) {
    super("Identity has been deleted");
    this.name = "IdentityBarredError";
    Object.setPrototypeOf(this, IdentityBarredError.prototype);
  }
}

/**
 * Transaction-scoped advisory lock on one auth identity — the common
 * serialization primitive between token mint and the deletion teardown.
 * Both sides take it before touching the barrier or the AuthMethod rows, so
 * a mint racing a deletion either completes first (and is then torn down) or
 * observes the committed barrier inside its own transaction. Without it, a
 * mint that passed the handler's unlocked barrier pre-check could recreate
 * a freshly deleted account behind its permanent barrier.
 */
export const lockIdentityForMintOrDeletion = async (
  tx: Prisma.TransactionClient,
  identityHash: string,
): Promise<void> => {
  // $executeRaw: pg_advisory_xact_lock returns void, which $queryRaw cannot
  // deserialize.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${identityHash}, 0))`;
};

export async function upsertAuthMethodAndAccount(args: {
  type: AuthMethodType;
  externalKey: string;
  onCreate?: (
    tx: Prisma.TransactionClient,
    accountId: string,
  ) => Promise<unknown>;
}): Promise<{ accountId: string; created: boolean }> {
  const identityHash = hashDeletedIdentity(args.type, args.externalKey);
  const findOrInsert = () =>
    prisma.$transaction(async (tx) => {
      // Serialize with the deletion teardown, then re-check the barrier
      // inside this transaction: the handler's earlier check ran unlocked,
      // and a deletion may have committed in between.
      await lockIdentityForMintOrDeletion(tx, identityHash);
      const barred = await tx.deletedIdentity.findUnique({
        where: { identityHash },
        select: { identityHash: true },
      });
      if (barred) {
        throw new IdentityBarredError(args.type, args.externalKey);
      }

      const existing = await tx.authMethod.findUnique({
        where: {
          type_externalKey: { type: args.type, externalKey: args.externalKey },
        },
      });
      if (existing) return { accountId: existing.accountId, created: false };

      const account = await tx.account.create({ data: {} });
      await tx.authMethod.create({
        data: {
          accountId: account.id,
          type: args.type,
          externalKey: args.externalKey,
        },
      });
      if (args.onCreate) await args.onCreate(tx, account.id);
      return { accountId: account.id, created: true };
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
