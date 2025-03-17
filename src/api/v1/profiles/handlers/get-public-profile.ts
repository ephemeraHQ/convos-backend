import { PrismaClient } from "@prisma/client";
import type { Request, Response } from "express";
import type { ProfileRequestResult } from "../profiles.types";

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
