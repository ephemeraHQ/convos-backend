import type { Request, Response } from "express";
import { prisma } from "@/utils/prisma";

// Admin full-row listing. Unlike the public read, this returns every row
// (including unpublished and over-length ones) so the curation surface can see
// and fix exactly the rows the public endpoint hides. Ordered the same way the
// public read serves them (sortOrder asc, then id) so the dashboard order
// matches what ships.
export async function listAdminHandler(req: Request, res: Response) {
  try {
    const rows = await prisma.agentPromptHint.findMany({
      orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
    });

    res.status(200).json({ data: rows });
    return;
  } catch (error) {
    req.log.error(
      { error, stack: error instanceof Error ? error.stack : undefined },
      "Failed to list agent prompt hints (admin)",
    );
    res.status(500).json({ error: "Failed to list agent prompt hints" });
    return;
  }
}
