import { type Request, type Response } from "express";
import { prisma } from "@/utils/prisma";

export type GetIdentityRequestParams = {
  identityId: string;
};

// GET /identities/:identityId - Get a single identity by ID
export const getIdentity = async (
  req: Request<GetIdentityRequestParams>,
  res: Response,
) => {
  try {
    const { identityId } = req.params;
    const { xmtpId } = req.app.locals;

    const identity = await prisma.deviceIdentity.findFirst({
      where: {
        id: identityId,
        xmtpId,
      },
    });

    if (!identity) {
      res.status(403).json({ error: "Not authorized to access this identity" });
      return;
    }

    res.json(identity);
  } catch {
    res.status(500).json({ error: "Failed to fetch identity" });
  }
};
