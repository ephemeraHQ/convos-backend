import type { Request, Response } from "express";
import { prisma } from "@/utils/prisma";

// 8 uppercase letters excluding visually ambiguous O and I
const CODE_PATTERN = /^[A-HJ-NP-Z]{8}$/;

/**
 * Handler for GET /api/v2/invite-codes/:code/status
 *
 * Returns the redemption status of an invite code, including how many
 * redemptions remain. Requires JWT authentication.
 */
export async function statusHandler(req: Request, res: Response) {
  const rawCode = req.params.code as string | undefined;

  const normalised = rawCode?.trim().toUpperCase() ?? "";

  if (!normalised || normalised.length > 8) {
    res.status(422).json({
      success: false,
      error: "CODE_INVALID_FORMAT",
      message: "Code must be 8 uppercase letters (excluding O and I)",
    });
    return;
  }

  if (!CODE_PATTERN.test(normalised)) {
    res.status(422).json({
      success: false,
      error: "CODE_INVALID_FORMAT",
      message: "Code must be 8 uppercase letters (excluding O and I)",
    });
    return;
  }

  try {
    const inviteCode = await prisma.inviteCode.findUnique({
      where: { code: normalised },
      select: {
        code: true,
        name: true,
        maxRedemptions: true,
        redemptionCount: true,
      },
    });

    if (!inviteCode) {
      res.status(404).json({
        success: false,
        error: "CODE_NOT_FOUND",
        message: "No invite code found with that value",
      });
      return;
    }

    res.status(200).json({
      success: true,
      data: {
        code: inviteCode.code,
        name: inviteCode.name,
        maxRedemptions: inviteCode.maxRedemptions,
        redemptionCount: inviteCode.redemptionCount,
        remainingRedemptions:
          inviteCode.maxRedemptions - inviteCode.redemptionCount,
      },
    });
    return;
  } catch (error) {
    req.log.error(
      { error, stack: error instanceof Error ? error.stack : undefined },
      "Failed to get invite code status",
    );
    res.status(500).json({
      success: false,
      error: "INTERNAL_ERROR",
      message: "Failed to get invite code status",
    });
    return;
  }
}
