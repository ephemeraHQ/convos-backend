import type { Request, Response } from "express";
import { decodeAuditCursor } from "../audit-repository";
import { listLedgerPageByAccount, serializeLedger } from "../ledger-repository";
import { ledgerQuerySchema } from "../schemas/requests";

export const accountLedgerGetHandler = async (
  req: Request<{ accountId: string }>,
  res: Response,
): Promise<void> => {
  const parsed = ledgerQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res
      .status(400)
      .json({ code: "invalid_request", details: parsed.error.errors });
    return;
  }
  const rawCursor = parsed.data.cursor;
  const cursor = rawCursor ? decodeAuditCursor(rawCursor) : null;
  if (rawCursor && !cursor) {
    res.status(400).json({ code: "invalid_cursor" });
    return;
  }
  const { rows, nextCursor } = await listLedgerPageByAccount({
    accountId: req.params.accountId,
    cursor,
  });
  res.status(200).json({ rows: rows.map(serializeLedger), nextCursor });
};
