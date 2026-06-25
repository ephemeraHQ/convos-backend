import { Prisma } from "@prisma/client";
import type { Request, Response } from "express";
import { prisma } from "@/utils/prisma";

// The API serves each hint as a short string under `hints`. The DB column is
// generous TEXT so curation is never lossy, so the read path is where the
// published contract is enforced: never serve an over-length hint (clients
// budget for <= 240 characters) and cap the payload size. Filtering and the
// limit run in SQL so the cap counts only contract-valid rows.
const MAX_HINT_LENGTH = 240;
const MAX_HINTS = 1000;

export async function listHandler(req: Request, res: Response) {
  try {
    const rows = await prisma.$queryRaw<Array<{ text: string }>>(
      Prisma.sql`
        SELECT "text"
        FROM "AgentPromptHint"
        WHERE "published" = true
          AND char_length("text") <= ${MAX_HINT_LENGTH}
        ORDER BY "sortOrder" ASC, "id" ASC
        LIMIT ${MAX_HINTS}
      `,
    );

    res.status(200).json({ hints: rows.map((row) => row.text) });
  } catch (error) {
    req.log.error(
      { error, stack: error instanceof Error ? error.stack : undefined },
      "Failed to list agent prompt hints",
    );
    res.status(500).json({ error: "Failed to list agent prompt hints" });
  }
}
