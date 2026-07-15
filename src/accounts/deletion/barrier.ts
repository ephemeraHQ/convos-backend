import type { Prisma } from "@prisma/client";
import { hashDeletedIdentity } from "@/accounts/deletion/identity-hash";
import { prisma } from "@/utils/prisma";

/**
 * The deletion barrier. One DeletedIdentity row per deleted auth identity,
 * keyed by hashDeletedIdentity. Consulted at token mint after successful SIWE
 * verification and before the auto-provisioning upsert: a barred identity
 * gets the terminal 410 identity_deleted response and never re-creates an
 * account (or re-earns the signup bonus). The bar is permanent.
 */

export const isIdentityBarred = async (
  type: string,
  externalKey: string,
): Promise<boolean> => {
  const row = await prisma.deletedIdentity.findUnique({
    where: { identityHash: hashDeletedIdentity(type, externalKey) },
    select: { identityHash: true },
  });
  return row !== null;
};

/**
 * Write the barrier row inside the deletion transaction. Idempotent: a
 * deletion retry that re-runs the teardown converges on the same row.
 */
export const barIdentityWithTx = async (
  tx: Prisma.TransactionClient,
  args: { type: string; externalKey: string },
): Promise<void> => {
  const identityHash = hashDeletedIdentity(args.type, args.externalKey);
  await tx.deletedIdentity.upsert({
    where: { identityHash },
    update: {},
    create: { identityHash },
  });
};
