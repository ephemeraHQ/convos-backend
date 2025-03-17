import { PrismaClient } from "@prisma/client";
import type { Request, Response } from "express";
import type { PublicProfileResult } from "../profiles.types";

const prisma = new PrismaClient();

type GetPublicProfileParams = {
  username: string;
};

export async function getPublicProfile(
  req: Request<GetPublicProfileParams>,
  res: Response,
) {
  try {
    const { username } = req.params;

    if (!username) {
      res.status(400).json({ error: "Username is required" });
      return;
    }

    const profile = await prisma.profile.findFirst({
      where: {
        username: {
          equals: username,
          mode: "insensitive",
        },
      },
      include: {
        deviceIdentity: {
          select: {
            xmtpId: true,
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
    };

    res.json(publicProfile);
  } catch {
    res.status(500).json({ error: "Failed to fetch profile" });
  }
}
