import type { Request, Response } from "express";
import { prisma } from "@/utils/prisma";
import type {
  GetProfileRequestParams,
  ProfileRequestResult,
} from "../profiles.types";

export async function getProfile(
  req: Request<GetProfileRequestParams>,
  res: Response,
) {
  try {
    const { xmtpId } = req.params;

    if (!xmtpId) {
      res.status(400).json({ error: "Invalid request body" });
      return;
    }

    const profile = await prisma.profile.findFirst({
      where: {
        deviceIdentity: {
          xmtpId,
        },
      },
      include: {
        deviceIdentity: {
          select: {
            xmtpId: true,
            privyAddress: true,
          },
        },
      },
    });

    if (!profile) {
      res.status(404).json({ error: "Profile not found" });
      return;
    }

    const profileResult: ProfileRequestResult = {
      id: profile.id,
      name: profile.name,
      username: profile.username,
      description: profile.description,
      avatar: profile.avatar,
      xmtpId: profile.deviceIdentity.xmtpId,
      privyAddress: profile.deviceIdentity.privyAddress,
    };

    res.json(profileResult);
  } catch {
    res.status(500).json({ error: "Failed to fetch profile" });
  }
}
