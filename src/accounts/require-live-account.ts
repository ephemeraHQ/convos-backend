import type { Prisma } from "@prisma/client";

/**
 * Thrown by requireLiveAccount when the account row is gone (deleted, or never
 * existed). Callers map it to their route's auth-failure response.
 */
export class AccountNotLiveError extends Error {
  constructor(public readonly accountId: string) {
    super("Account is not live");
    this.name = "AccountNotLiveError";
    Object.setPrototypeOf(this, AccountNotLiveError.prototype);
  }
}

/**
 * Existence check + serialization point for writers that attach
 * account-linked state, fencing them against a concurrent account deletion.
 *
 * `SELECT ... FOR KEY SHARE` conflicts with the deletion transaction's
 * `FOR UPDATE` on the same Account row but not with other FOR KEY SHARE
 * holders, so writers serialize against deletion only, never against each
 * other. Under READ COMMITTED, a writer that blocks on the deletion's lock
 * re-reads once the deletion commits, finds no row, and aborts here; a writer
 * that acquired its lock first commits ahead of the deletion, whose sweep
 * statements then see and remove its rows.
 *
 * Mandatory at FK-less writer sites (ClientIdentifier upsert, AdminAudit
 * insert); FK-backed writers get the same lock implicitly from their
 * referential-integrity check. Must run inside the same transaction as the
 * write it fences.
 */
export const requireLiveAccount = async (
  tx: Prisma.TransactionClient,
  accountId: string,
): Promise<void> => {
  const rows = await tx.$queryRaw<Array<{ ok: number }>>`
    SELECT 1 AS ok FROM "Account" WHERE id = ${accountId}::uuid FOR KEY SHARE
  `;
  if (rows.length === 0) {
    throw new AccountNotLiveError(accountId);
  }
};
