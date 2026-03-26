import type { Request, Response } from "express";
import { z } from "zod";
import { prisma } from "@/utils/prisma";

// 8 uppercase letters excluding visually ambiguous O and I
const CODE_PATTERN = /^[A-HJ-NP-Z]{8}$/;

const bodySchema = z.object({
  code: z.string().min(1, "Code is required").max(8),
});

/**
 * Handler for POST /api/v2/invite-codes/redeem
 *
 * Redeems an invite code for the "Instant assistant" feature.
 * The backend does not record who redeemed the code — it only validates
 * the code and marks it as used. The client stores the unlock state locally.
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
    // Atomic update: only redeem if the code exists AND hasn't been redeemed yet.
    // This avoids the TOCTOU race where two concurrent requests both read
    // redeemedAt as null and both succeed.
    const result = await prisma.inviteCode.updateMany({
      where: { code: normalised, redeemedAt: null },
      data: { redeemedAt: new Date() },
    });

    if (result.count === 1) {
      req.log.info({ code: normalised }, "Invite code redeemed");
      res.status(200).json({ success: true });
      return;
    }

    // count === 0: either the code doesn't exist or it was already redeemed.
    // One more read to distinguish the two cases for the error response.
    const existing = await prisma.inviteCode.findUnique({
      where: { code: normalised },
      select: { redeemedAt: true },
    });

    if (!existing) {
      res.status(404).json({
        success: false,
        error: "CODE_NOT_FOUND",
        message: "No invite code found with that value",
      });
      return;
    }

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
