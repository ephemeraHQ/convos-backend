import type { Request, Response } from "express";
import { z } from "zod";
import { prisma } from "@/utils/prisma";
import { generateUniqueCodes } from "../utils/code-generator";

const MAX_BATCH_SIZE = 500;
const MAX_GENERATION_RETRIES = 3;

const bodySchema = z.object({
  count: z
    .number()
    .int()
    .min(1, "Count must be at least 1")
    .max(MAX_BATCH_SIZE, `Count must be at most ${MAX_BATCH_SIZE}`),
  batchLabel: z.string().max(255, "Batch label too long").optional().nullable(),
  name: z.string().max(255, "Name too long").optional().nullable(),
  maxRedemptions: z
    .number()
    .int()
    .min(1, "Max redemptions must be at least 1")
    .optional()
    .default(1),
});

/**
 * Handler for POST /api/v2/invite-codes/generate
 *
 * Bulk-generates invite codes. This endpoint is intended for internal use
 * (Retool admin panel) and is protected by the dev auth middleware.
 *
 * Request body:
 *   - count: number of codes to generate (1–500)
 *   - batchLabel: optional label for tracking distribution campaigns
 *
 * Response: array of generated codes
 */
export async function generateHandler(req: Request, res: Response) {
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      success: false,
      error: "INVALID_REQUEST",
      message: parsed.error.issues[0]?.message ?? "Invalid request",
    });
    return;
  }

  const { count, batchLabel, name, maxRedemptions } = parsed.data;

  try {
    let codes: string[] = [];
    let retries = 0;

    // Retry loop to handle (extremely unlikely) collisions with existing codes.
    // We can't trust candidates ordering after skipDuplicates, so we query
    // back the codes that were actually inserted in each batch.
    while (codes.length < count && retries < MAX_GENERATION_RETRIES) {
      const remaining = count - codes.length;
      const candidates = generateUniqueCodes(remaining);

      // Find which candidates already exist before inserting
      const existing = await prisma.inviteCode.findMany({
        where: { code: { in: candidates } },
        select: { code: true },
      });
      const existingSet = new Set(existing.map((r) => r.code));

      await prisma.inviteCode.createMany({
        data: candidates.map((code) => ({
          code,
          batchLabel: batchLabel ?? null,
          name: name ?? null,
          maxRedemptions,
        })),
        skipDuplicates: true,
      });

      // Only include candidates that didn't exist before the insert
      const newCodes = candidates.filter((c) => !existingSet.has(c));
      codes = codes.concat(newCodes);
      retries++;
    }

    if (codes.length < count) {
      req.log.warn(
        { requested: count, generated: codes.length },
        "Could not generate all requested codes after retries",
      );
    }

    req.log.info(
      { count: codes.length, batchLabel, name, maxRedemptions },
      "Invite codes generated",
    );

    res.status(201).json({
      success: true,
      data: {
        codes,
        count: codes.length,
        batchLabel: batchLabel ?? null,
        name: name ?? null,
        maxRedemptions,
      },
    });
    return;
  } catch (error) {
    req.log.error(
      { error, stack: error instanceof Error ? error.stack : undefined },
      "Failed to generate invite codes",
    );
    res.status(500).json({
      success: false,
      error: "INTERNAL_ERROR",
      message: "Failed to generate invite codes",
    });
    return;
  }
}
