import type { Request, Response } from "express";
import { prisma } from "@/utils/prisma";
import type { PublicProfileResult } from "../profiles.types";

type GetPublicProfileParams = {
  username?: string;
  xmtpId?: string;
};

export async function getPublicProfile(
  req: Request<GetPublicProfileParams>,
  res: Response,
) {
  try {
    const { username, xmtpId } = req.params;

    if (!username && !xmtpId) {
      res.status(400).json({ error: "Either username or xmtpId is required" });
      return;
    }

    const profile = await prisma.profile.findFirst({
      where: username
        ? {
            username: {
              equals: username,
              mode: "insensitive",
            },
          }
        : {
            deviceIdentity: {
              xmtpId,
            },
          },
      include: {
        deviceIdentity: {
          select: {
            xmtpId: true,
            turnkeyAddress: true,
          },
        },
      },
    });

    if (!profile || !profile.deviceIdentity.xmtpId) {
      res.status(404).json({ error: "Profile not found" });
      return;
    }

    // Return only public profile data
    const publicProfile: PublicProfileResult = {
      name: profile.name,
      username: profile.username,
      description: profile.description,
      avatar: profile.avatar,
      xmtpId: profile.deviceIdentity.xmtpId,
      turnkeyAddress: profile.deviceIdentity.turnkeyAddress,
    };

    res.json(publicProfile);
  } catch {
    res.status(500).json({ error: "Failed to fetch profile" });
  }
}
