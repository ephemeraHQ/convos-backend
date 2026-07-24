import type { Request, Response } from "express";
import { decodeAuditCursor, listRecentAdminAudit } from "../audit-repository";
import { auditRecentQuerySchema } from "../schemas/requests";

export const auditRecentGetHandler = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const parsed = auditRecentQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res
      .status(400)
      .json({ code: "invalid_request", details: parsed.error.errors });
    return;
  }
  const { cursor: rawCursor, action } = parsed.data;
  const cursor = rawCursor ? decodeAuditCursor(rawCursor) : null;
  if (rawCursor && !cursor) {
    res.status(400).json({ code: "invalid_cursor" });
    return;
  }
  const { rows, nextCursor } = await listRecentAdminAudit({
    cursor,
    action: action === "all" ? null : action,
  });
  res.status(200).json({
    rows: rows.map((r) => ({
      id: r.id,
      accountId: r.accountId,
      actorEmail: r.actorEmail,
      action: r.action,
      deltaCredits: r.deltaCredits.toString(),
      reason: r.reason,
      createdAt: r.createdAt.toISOString(),
      idempotencyKey: r.idempotencyKey,
    })),
    nextCursor,
  });
};
