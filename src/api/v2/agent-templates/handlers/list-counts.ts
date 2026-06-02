import type { Request, Response } from "express";
import { prisma } from "@/utils/prisma";
import { visibilityWhere } from "../lib/visibility";

const STATUSES = ["published", "draft", "unlisted", "archived"] as const;

/**
 * GET /api/v2/agent-templates/counts
 *
 * Aggregate counts over the caller's visible template set — for the admin
 * dashboard's facet rail (e.g. "Published 1.2k", "Drafts 340"). Counts reflect
 * visibility only (not the active status/category/search filters), so the rail
 * always shows the shape of the whole catalog the caller can see.
 *
 * Response: { total, byStatus: {published,draft,unlisted,archived}, byCategory, featured }
 */
export async function listCountsHandler(req: Request, res: Response) {
  const accountId: string | undefined = res.locals.accountId;
  const isApiKeyListener = res.locals.isApiKeyListener ?? false;
  const where = visibilityWhere(accountId, isApiKeyListener);

  try {
    const [total, byStatusRows, byCategoryRows, featured] = await Promise.all([
      prisma.agentTemplate.count({ where }),
      prisma.agentTemplate.groupBy({
        by: ["status"],
        where,
        _count: { _all: true },
      }),
      prisma.agentTemplate.groupBy({
        by: ["category"],
        where,
        _count: { _all: true },
      }),
      prisma.agentTemplate.count({
        where: { AND: [where, { featured: true }] },
      }),
    ]);

    const byStatus: Record<string, number> = {};
    for (const status of STATUSES) byStatus[status] = 0;
    for (const row of byStatusRows) byStatus[row.status] = row._count._all;

    const byCategory: Record<string, number> = {};
    for (const row of byCategoryRows) {
      byCategory[row.category ?? "uncategorized"] = row._count._all;
    }

    res.status(200).json({ total, byStatus, byCategory, featured });
  } catch (error) {
    req.log.error(
      { error, stack: error instanceof Error ? error.stack : undefined },
      "Failed to count agent templates",
    );
    res.status(500).json({ error: "Failed to count agent templates" });
  }
}
