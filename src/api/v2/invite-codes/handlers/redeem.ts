import type { Request, Response } from "express";
import { z } from "zod";
import { prisma } from "@/utils/prisma";
import { generateCode } from "../utils/code-generator";

// 8 uppercase letters excluding visually ambiguous O and I
const CODE_PATTERN = /^[A-HJ-NP-Z]{8}$/;

const DEFAULT_CHILD_CODE_MAX_REDEMPTIONS_FALLBACK = 5;
const parsedDefaultChildCodeMaxRedemptions = parseInt(
  process.env.DEFAULT_CHILD_CODE_MAX_REDEMPTIONS ?? "",
  10,
);
const DEFAULT_CHILD_CODE_MAX_REDEMPTIONS = Number.isNaN(
  parsedDefaultChildCodeMaxRedemptions,
)
  ? DEFAULT_CHILD_CODE_MAX_REDEMPTIONS_FALLBACK
  : parsedDefaultChildCodeMaxRedemptions;

const MAX_CODE_GENERATION_ATTEMPTS = 5;

const bodySchema = z.object({
  code: z.string().min(1, "Code is required").max(8),
});

/**
 * Handler for POST /api/v2/invite-codes/redeem
 *
 * Redeems an invite code for the "Instant assistant" feature.
 * On successful redemption, generates a new child invite code for the
 * redeemer with a configurable number of max redemptions (default: 5).
 *
 * The backend does not record who redeemed the code — it only validates
 * the code, increments the redemption count, and returns the child code.
 * The client stores the unlock state locally.
 */
export async function redeemHandler(req: Request, res: Response) {
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(422).json({
      success: false,
      error: "CODE_INVALID_FORMAT",
      message: parsed.error.issues[0]?.message ?? "Invalid code format",
    });
    return;
  }

  const { code } = parsed.data;
  const normalised = code.toUpperCase().trim();

  // Validate format before hitting the database
  if (!CODE_PATTERN.test(normalised)) {
    res.status(422).json({
      success: false,
      error: "CODE_INVALID_FORMAT",
      message: "Code must be 8 uppercase letters (excluding O and I)",
    });
    return;
  }

  try {
    // Atomic compare-and-increment: only redeem if the code exists AND
    // has remaining redemptions. Uses a raw query because Prisma's
    // updateMany can't compare two columns in the where clause.
    // This avoids the TOCTOU race where two concurrent requests both
    // read redemptionCount and both succeed past the limit.
    const updateResult: { id: string }[] = await prisma.$queryRaw`
      UPDATE "InviteCode"
      SET "redemptionCount" = "redemptionCount" + 1,
          "redeemedAt" = NOW()
      WHERE "code" = ${normalised}
        AND "redemptionCount" < "maxRedemptions"
      RETURNING "id"
    `;

    if (updateResult.length === 1) {
      const parentCodeId = updateResult[0].id;

      // Generate a unique child code (retry on collision)
      let childCode: string | null = null;
      for (let i = 0; i < MAX_CODE_GENERATION_ATTEMPTS; i++) {
        const candidate = generateCode();
        const existing = await prisma.inviteCode.findUnique({
          where: { code: candidate },
          select: { id: true },
        });
        if (!existing) {
          childCode = candidate;
          break;
        }
      }

      if (!childCode) {
        // Extremely unlikely — roll back the redemption count
        await prisma.$queryRaw`
          UPDATE "InviteCode"
          SET "redemptionCount" = "redemptionCount" - 1
          WHERE "id" = ${parentCodeId}::uuid
        `;
        req.log.error(
          { code: normalised },
          "Failed to generate unique child code after retries",
        );
        res.status(500).json({
          success: false,
          error: "INTERNAL_ERROR",
          message: "Failed to generate invite code",
        });
        return;
      }

      // Create child code and redemption record in a transaction
      const childInviteCode = await prisma.$transaction(async (tx) => {
        const child = await tx.inviteCode.create({
          data: {
            code: childCode!,
            maxRedemptions: DEFAULT_CHILD_CODE_MAX_REDEMPTIONS,
            parentCodeId,
          },
        });

        await tx.inviteCodeRedemption.create({
          data: {
            inviteCodeId: parentCodeId,
            childCodeId: child.id,
          },
        });

        return child;
      });

      req.log.info(
        {
          code: normalised,
          childCode: childInviteCode.code,
          childMaxRedemptions: DEFAULT_CHILD_CODE_MAX_REDEMPTIONS,
        },
        "Invite code redeemed, child code generated",
      );

      res.status(200).json({
        success: true,
        data: {
          inviteCode: {
            code: childInviteCode.code,
            name: childInviteCode.name,
            maxRedemptions: childInviteCode.maxRedemptions,
            redemptionCount: childInviteCode.redemptionCount,
            remainingRedemptions:
              childInviteCode.maxRedemptions -
              childInviteCode.redemptionCount,
          },
        },
      });
      return;
    }

    // updateResult.length === 0: either the code doesn't exist or it's
    // fully redeemed. One more read to distinguish the two cases.
    const existing = await prisma.inviteCode.findUnique({
      where: { code: normalised },
      select: { redemptionCount: true, maxRedemptions: true },
    });

    if (!existing) {
      res.status(404).json({
        success: false,
        error: "CODE_NOT_FOUND",
        message: "No invite code found with that value",
      });
      return;
    }

    // Code exists but fully redeemed — keep CODE_ALREADY_REDEEMED for
    // backwards compatibility with existing iOS clients.
    res.status(409).json({
      success: false,
      error: "CODE_ALREADY_REDEEMED",
      message: "This invite code has already been used",
    });
    return;
  } catch (error) {
    req.log.error(
      { error, stack: error instanceof Error ? error.stack : undefined },
      "Failed to redeem invite code",
    );
    res.status(500).json({
      success: false,
      error: "INTERNAL_ERROR",
      message: "Failed to redeem invite code",
    });
    return;
  }
}
