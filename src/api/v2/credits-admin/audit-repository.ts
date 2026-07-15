import type { AdminAudit } from "@prisma/client";
import { requireLiveAccount } from "@/accounts/require-live-account";
import { prisma } from "@/utils/prisma";

export type AdminAuditAction = "grant" | "adjust";

export const writeAdminAudit = async (args: {
  accountId: string;
  actorEmail: string;
  action: AdminAuditAction;
  deltaCredits: bigint;
  reason: string;
  idempotencyKey: string;
}): Promise<void> => {
  // AdminAudit.accountId is a plain scalar (no FK to Account); fence the
  // insert against a concurrent account deletion via requireLiveAccount in
  // the same transaction (throws AccountNotLiveError when the account is
  // gone — surfaces as a 500 on the admin surface, acceptable for the
  // razor-thin race the up-front handler existence check does not cover).
  await prisma.$transaction(async (tx) => {
    await requireLiveAccount(tx, args.accountId);
    await tx.adminAudit.upsert({
      where: {
        accountId_idempotencyKey: {
          accountId: args.accountId,
          idempotencyKey: args.idempotencyKey,
        },
      },
      update: {},
      create: args,
    });
  });
};

const AUDIT_LIST_LIMIT = 50;

export const listAdminAuditByAccount = async (
  accountId: string,
  limit: number = AUDIT_LIST_LIMIT,
): Promise<AdminAudit[]> => {
  return prisma.adminAudit.findMany({
    where: { accountId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit,
  });
};
