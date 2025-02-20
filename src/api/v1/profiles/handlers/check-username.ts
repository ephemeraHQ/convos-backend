import { PrismaClient } from "@prisma/client";
import type { Request, Response } from "express";

const prisma = new PrismaClient();

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
      res.status(400).json({ error: "Username is required" });
      return;
    }

    // Find the profile through case-insensitive username match
    const profile = await prisma.profile.findFirst({
      where: {
        name: {
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
