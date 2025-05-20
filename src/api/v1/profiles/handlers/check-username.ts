import type { Request, Response } from "express";
import { prisma } from "@/utils/prisma";

type CheckUsernameParams = {
  username: string;
};

type CheckUsernameResponse =
  | {
      taken: boolean;
    }
  | {
      error: string;
    };

export async function checkUsername(
  req: Request<CheckUsernameParams>,
  res: Response<CheckUsernameResponse>,
) {
  try {
    const { username } = req.params;

    if (!username || username.trim().length === 0) {
      res.status(404).json({ error: "Profile not found" });
      return;
    }

    // Find the profile through case-insensitive username match
    const profile = await prisma.profile.findFirst({
      where: {
        username: {
          equals: username,
          mode: "insensitive",
        },
      },
    });

    res.json({
      taken: !!profile,
    });
  } catch {
    res.status(500).json({ error: "Failed to check username" });
  }
}
