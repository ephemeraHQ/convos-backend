import crypto from "node:crypto";
import type { Request, Response } from "express";
import { z } from "zod";
import { prisma } from "@/utils/prisma";

// Uppercase letters excluding visually ambiguous O and I
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const CODE_LENGTH = 8;
const MAX_BATCH_SIZE = 500;
const MAX_GENERATION_RETRIES = 3;

const bodySchema = z.object({
  count: z
    .number()
    .int()
    .min(1, "Count must be at least 1")
    .max(MAX_BATCH_SIZE, `Count must be at most ${MAX_BATCH_SIZE}`),
  batchLabel: z.string().max(255, "Batch label too long").optional().nullable(),
});

function generateCode(): string {
  const bytes = crypto.randomBytes(CODE_LENGTH);
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return code;
}

function generateUniqueCodes(count: number): string[] {
  const codes = new Set<string>();
  // Guard against infinite loops with a generous iteration cap
  const maxIterations = count * 10;
  let iterations = 0;
  while (codes.size < count && iterations < maxIterations) {
    codes.add(generateCode());
    iterations++;
  }
  return Array.from(codes);
}

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

  const { count, batchLabel } = parsed.data;

  try {
    let codes: string[] = [];
    let retries = 0;

    // Retry loop to handle (extremely unlikely) collisions with existing codes.
    // We can't trust candidates ordering after skipDuplicates, so we query
    // back the codes that were actually inserted in each batch.
    while (codes.length < count && retries < MAX_GENERATION_RETRIES) {
      const remaining = count - codes.length;
      const candidates = generateUniqueCodes(remaining);

      await prisma.inviteCode.createMany({
        data: candidates.map((code) => ({
          code,
          batchLabel: batchLabel ?? null,
        })),
        skipDuplicates: true,
      });

      // Query back which candidates were actually inserted (skipped
      // duplicates won't be found with this batch label + code combo)
      const inserted = await prisma.inviteCode.findMany({
        where: { code: { in: candidates }, batchLabel: batchLabel ?? null },
        select: { code: true },
      });

      codes = codes.concat(inserted.map((r) => r.code));
      retries++;
    }

    if (codes.length < count) {
      req.log.warn(
        { requested: count, generated: codes.length },
        "Could not generate all requested codes after retries",
      );
    }

    req.log.info({ count: codes.length, batchLabel }, "Invite codes generated");

    res.status(201).json({
      success: true,
      data: {
        codes,
        count: codes.length,
        batchLabel: batchLabel ?? null,
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
