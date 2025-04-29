import type { Request, Response } from "express";
import { isAddress } from "viem";
import { prisma } from "@/utils/prisma";
import type { ProfileRequestResult } from "../profiles.types";

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
          ...(isAddress(trimmedQuery)
            ? [
                {
                  deviceIdentity: {
                    turnkeyAddress: trimmedQuery,
                  },
                },
              ]
            : []),
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
            turnkeyAddress: true,
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
            turnkeyAddress: profile.deviceIdentity.turnkeyAddress,
          }) satisfies ProfileRequestResult,
      ),
    );
  } catch {
    res.status(500).json({ error: "Failed to search profiles" });
  }
}
