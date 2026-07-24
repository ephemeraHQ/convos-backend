import type { Request, Response } from "express";
import {
  decodeAuditCursor,
  listAdminAuditPageByAccount,
} from "../audit-repository";
import { auditQuerySchema } from "../schemas/requests";

export const auditGetHandler = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const parsed = auditQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res
      .status(400)
      .json({ code: "invalid_request", details: parsed.error.errors });
    return;
  }
  const { accountId, cursor: rawCursor } = parsed.data;
  const cursor = rawCursor ? decodeAuditCursor(rawCursor) : null;
  if (rawCursor && !cursor) {
    res.status(400).json({ code: "invalid_cursor" });
    return;
  }
  const { rows, nextCursor } = await listAdminAuditPageByAccount({
    accountId,
    cursor,
  });
  res.status(200).json({
    audit: rows.map((r) => ({
      id: r.id,
      actorEmail: r.actorEmail,
      action: r.action,
      deltaCredits: r.deltaCredits.toString(),
      reason: r.reason,
      idempotencyKey: r.idempotencyKey,
      createdAt: r.createdAt.toISOString(),
    })),
    nextCursor,
  });
};
