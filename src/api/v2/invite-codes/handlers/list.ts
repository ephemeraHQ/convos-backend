import { Prisma } from "@prisma/client";
import type { Request, Response } from "express";
import { z } from "zod";
import { prisma } from "@/utils/prisma";

const querySchema = z.object({
  batchLabel: z.string().optional(),
  status: z.enum(["pending", "redeemed", "all"]).optional().default("all"),
  limit: z.coerce.number().int().min(1).max(500).optional().default(100),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

/**
 * Handler for GET /api/v2/invite-codes
 *
 * Lists invite codes with filtering. This endpoint is intended for
 * internal use (Retool admin panel) and is protected by the dev auth middleware.
 *
 * Query parameters:
 *   - batchLabel: filter by batch label
 *   - status: "pending" | "redeemed" | "all" (default: "all")
 *     - "pending" = redemptionCount < maxRedemptions (has remaining uses)
 *     - "redeemed" = redemptionCount >= maxRedemptions (fully exhausted)
 *   - limit: max results (1–500, default: 100)
 *   - offset: pagination offset (default: 0)
 */
export async function listHandler(req: Request, res: Response) {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({
      success: false,
      error: "INVALID_REQUEST",
      message: parsed.error.issues[0]?.message ?? "Invalid query parameters",
    });
    return;
  }

  const { batchLabel, status, limit, offset } = parsed.data;

  try {
    // Build WHERE clauses using Prisma.sql for safe parameterization.
    // We need raw SQL because Prisma can't compare two columns
    // (redemptionCount vs maxRedemptions) in a where clause.
    const conditions: Prisma.Sql[] = [];

    if (status === "pending") {
      conditions.push(Prisma.sql`"redemptionCount" < "maxRedemptions"`);
    } else if (status === "redeemed") {
      conditions.push(Prisma.sql`"redemptionCount" >= "maxRedemptions"`);
    }

    if (batchLabel !== undefined) {
      conditions.push(Prisma.sql`"batchLabel" = ${batchLabel}`);
    }

    const whereClause =
      conditions.length > 0
        ? Prisma.sql`WHERE ${Prisma.join(conditions, " AND ")}`
        : Prisma.empty;

    const codes = await prisma.$queryRaw<
      Array<{
        id: string;
        code: string;
        name: string | null;
        maxRedemptions: number;
        redemptionCount: number;
        createdAt: Date;
        redeemedAt: Date | null;
        batchLabel: string | null;
        parentCodeId: string | null;
      }>
    >(
      Prisma.sql`SELECT "id", "code", "name", "maxRedemptions", "redemptionCount",
              "createdAt", "redeemedAt", "batchLabel", "parentCodeId"
       FROM "InviteCode"
       ${whereClause}
       ORDER BY "createdAt" DESC
       LIMIT ${limit} OFFSET ${offset}`,
    );

    const totalResult = await prisma.$queryRaw<Array<{ count: bigint }>>(
      Prisma.sql`SELECT COUNT(*) as count FROM "InviteCode" ${whereClause}`,
    );
    const total = Number(totalResult[0]?.count ?? 0);

    // Look up parent codes for display
    const parentCodeIds = codes
      .map((c) => c.parentCodeId)
      .filter((id): id is string => id !== null);
    const parentCodes =
      parentCodeIds.length > 0
        ? await prisma.inviteCode.findMany({
            where: { id: { in: parentCodeIds } },
            select: { id: true, code: true },
          })
        : [];
    const parentCodeMap = new Map(parentCodes.map((p) => [p.id, p.code]));

    res.status(200).json({
      success: true,
      data: {
        codes: codes.map((c) => ({
          id: c.id,
          code: c.code,
          name: c.name,
          createdAt: c.createdAt,
          redeemedAt: c.redeemedAt,
          batchLabel: c.batchLabel,
          // Backwards-compatible status: "pending" or "redeemed"
          status:
            c.redemptionCount >= c.maxRedemptions ? "redeemed" : "pending",
          maxRedemptions: c.maxRedemptions,
          redemptionCount: c.redemptionCount,
          remainingRedemptions: c.maxRedemptions - c.redemptionCount,
          parentCode: c.parentCodeId
            ? (parentCodeMap.get(c.parentCodeId) ?? null)
            : null,
        })),
        total,
        limit,
        offset,
      },
    });
    return;
  } catch (error) {
    req.log.error(
      { error, stack: error instanceof Error ? error.stack : undefined },
      "Failed to list invite codes",
    );
    res.status(500).json({
      success: false,
      error: "INTERNAL_ERROR",
      message: "Failed to list invite codes",
    });
    return;
  }
}
