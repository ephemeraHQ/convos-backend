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
    const where: Record<string, unknown> = {};

    if (batchLabel !== undefined) {
      where.batchLabel = batchLabel;
    }

    if (status === "pending") {
      where.redeemedAt = null;
    } else if (status === "redeemed") {
      where.redeemedAt = { not: null };
    }

    const [codes, total] = await Promise.all([
      prisma.inviteCode.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: limit,
        skip: offset,
        select: {
          id: true,
          code: true,
          createdAt: true,
          redeemedAt: true,
          batchLabel: true,
        },
      }),
      prisma.inviteCode.count({ where }),
    ]);

    res.status(200).json({
      success: true,
      data: {
        codes: codes.map((c) => ({
          ...c,
          status: c.redeemedAt ? "redeemed" : "pending",
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
