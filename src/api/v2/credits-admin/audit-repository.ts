import type { AdminAudit, Prisma } from "@prisma/client";
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
  await prisma.adminAudit.upsert({
    where: {
      accountId_idempotencyKey: {
        accountId: args.accountId,
        idempotencyKey: args.idempotencyKey,
      },
    },
    update: {},
    create: args,
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

export type RecentAuditCursor = { createdAt: Date; id: string };

const CURSOR_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Delimiter-safe: neither field can contain "|" (ISO timestamp + UUID id).
export const encodeAuditCursor = (r: { createdAt: Date; id: string }): string =>
  Buffer.from(`${r.createdAt.toISOString()}|${r.id}`).toString("base64url");

export const decodeAuditCursor = (raw: string): RecentAuditCursor | null => {
  try {
    const decoded = Buffer.from(raw, "base64url").toString("utf8");
    const idx = decoded.indexOf("|");
    if (idx < 0) return null;
    const createdAt = new Date(decoded.slice(0, idx));
    const id = decoded.slice(idx + 1);
    // id must be a UUID: the keyset compares it against the uuid `id` column, so
    // a non-uuid would raise a Postgres 22P02 (500) instead of a clean 400.
    if (Number.isNaN(createdAt.getTime()) || !CURSOR_ID_RE.test(id))
      return null;
    return { createdAt, id };
  } catch {
    return null;
  }
};

export const listRecentAdminAudit = async (args: {
  limit?: number;
  cursor?: RecentAuditCursor | null;
  action?: AdminAuditAction | null;
}): Promise<{ rows: AdminAudit[]; nextCursor: string | null }> => {
  const limit = args.limit ?? AUDIT_LIST_LIMIT;
  const where: Prisma.AdminAuditWhereInput = {};
  if (args.action) where.action = args.action;
  if (args.cursor) {
    // Keyset (createdAt, id) < (cursor). Prisma has no tuple comparison, so
    // OR-expand. The id tiebreaker keeps paging stable when createdAt collides.
    where.OR = [
      { createdAt: { lt: args.cursor.createdAt } },
      { createdAt: args.cursor.createdAt, id: { lt: args.cursor.id } },
    ];
  }
  const rows = await prisma.adminAudit.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
  });
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page.at(-1);
  const nextCursor = hasMore && last ? encodeAuditCursor(last) : null;
  return { rows: page, nextCursor };
};

export const listAdminAuditPageByAccount = async (args: {
  accountId: string;
  cursor?: RecentAuditCursor | null;
  limit?: number;
}): Promise<{ rows: AdminAudit[]; nextCursor: string | null }> => {
  const limit = args.limit ?? AUDIT_LIST_LIMIT;
  const where: Prisma.AdminAuditWhereInput = { accountId: args.accountId };
  if (args.cursor) {
    where.OR = [
      { createdAt: { lt: args.cursor.createdAt } },
      { createdAt: args.cursor.createdAt, id: { lt: args.cursor.id } },
    ];
  }
  const rows = await prisma.adminAudit.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
  });
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page.at(-1);
  const nextCursor = hasMore && last ? encodeAuditCursor(last) : null;
  return { rows: page, nextCursor };
};
