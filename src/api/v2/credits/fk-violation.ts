import type { Prisma } from "@prisma/client";

/**
 * Returns true only when the Prisma FK-violation error is for the accountId
 * foreign key. A future FK column on CreditLedger (e.g. agentId) would
 * produce a different constraint name and must NOT be classified as
 * account_not_found.
 *
 * P2003: typed query path — Prisma exposes meta.field_name (FK column name).
 * P2010: $queryRaw path — Postgres SQLSTATE 23503 with constraint name in msg.
 */
export const isAccountIdFkViolation = (
  err: Prisma.PrismaClientKnownRequestError,
): boolean => {
  if (err.code === "P2003") {
    const field = (err.meta as { field_name?: string } | undefined)?.field_name;
    return typeof field === "string" && field.includes("accountId");
  }
  if (err.code === "P2010") {
    const meta = err.meta as { code?: string; message?: string } | undefined;
    if (meta?.code !== "23503") return false;
    const msg = meta.message ?? "";
    return (
      msg.includes("UserCredits_accountId_fkey") ||
      msg.includes("CreditLedger_accountId_fkey")
    );
  }
  return false;
};
