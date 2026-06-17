import type { AdminAudit } from "@prisma/client";
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
  await prisma.adminAudit.create({ data: args });
};

const AUDIT_LIST_LIMIT = 50;

export const listAdminAuditByAccount = async (
  accountId: string,
  limit: number = AUDIT_LIST_LIMIT,
): Promise<AdminAudit[]> => {
  return prisma.adminAudit.findMany({
    where: { accountId },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
};
