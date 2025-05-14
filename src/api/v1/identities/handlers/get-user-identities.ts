import { type Request, type Response } from "express";
import { prisma } from "@/utils/prisma";

export type GetUserIdentitiesRequestParams = {
  userId: string;
};

// GET /identities/user/:userId - Get all identities for a user
export const getUserIdentities = async (
  req: Request<GetUserIdentitiesRequestParams>,
  res: Response,
) => {
  try {
    const { userId } = req.params;
    const { xmtpId } = req.app.locals;

    const identities = await prisma.deviceIdentity.findMany({
      where: { userId, xmtpId },
    });

    res.json(identities);
  } catch {
    res.status(500).json({ error: "Failed to fetch user identities" });
  }
};
