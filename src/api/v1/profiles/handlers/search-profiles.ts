import { PrismaClient } from "@prisma/client";
import type { Request, Response } from "express";
import type { ProfileRequestResult } from "../profiles.types";

const prisma = new PrismaClient();

type SearchProfilesQuery = {
  query: string;
};

export async function searchProfiles(
  req: Request<unknown, unknown, unknown, SearchProfilesQuery>,
  res: Response,
) {
  try {
    const query = req.query.query || "";
    const trimmedQuery = query.trim();

    if (trimmedQuery.length === 0) {
      res.status(400).json({ error: "Invalid search query" });
      return;
    }

    const profiles = await prisma.profile.findMany({
      where: {
        OR: [
          {
            name: {
              contains: trimmedQuery,
              mode: "insensitive",
            },
          },
          {
            username: {
              contains: trimmedQuery,
              mode: "insensitive",
            },
          },
        ],
        deviceIdentity: {
          xmtpId: {
            not: null,
          },
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
      take: 50,
    });

    res.json(
      profiles.map(
        (profile) =>
          ({
            id: profile.id,
            name: profile.name,
            username: profile.username,
            avatar: profile.avatar,
            description: profile.description,
            xmtpId: profile.deviceIdentity.xmtpId,
            privyAddress: profile.deviceIdentity.privyAddress,
          }) satisfies ProfileRequestResult,
      ),
    );
  } catch {
    res.status(500).json({ error: "Failed to search profiles" });
  }
}
