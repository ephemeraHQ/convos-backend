import type { RequestHandler } from "express";
import { z } from "zod";
import { prisma } from "@/utils/prisma";
import { batchGetProfilesSchema } from "../profile.schema";
import type {
  BatchGetProfilesRequestBody,
  BatchProfilesResponse,
  ProfileRequestResult,
} from "../profiles.types";

// Use a RequestHandler type with generic parameters
export const getBatchProfiles: RequestHandler<
  unknown,
  BatchProfilesResponse | { error: string; details?: z.ZodIssue[] },
  BatchGetProfilesRequestBody
> = async (req, res) => {
  try {
    // Validate request body
    let validatedData;
    try {
      validatedData = batchGetProfilesSchema.parse(req.body);
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({
          error: "Invalid request body",
          details: error.errors,
        });
        return;
      }
      throw error;
    }

    const { xmtpIds } = validatedData;

    // Get profiles with matching xmtpIds
    const profiles = await prisma.profile.findMany({
      where: {
        deviceIdentity: {
          xmtpId: {
            in: xmtpIds,
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
    });

    // Convert array to map keyed by xmtpId
    const profilesMap: Record<string, ProfileRequestResult> = {};

    profiles.forEach((profile) => {
      if (profile.deviceIdentity.xmtpId) {
        profilesMap[profile.deviceIdentity.xmtpId] = {
          id: profile.id,
          name: profile.name,
          username: profile.username,
          description: profile.description,
          avatar: profile.avatar,
          xmtpId: profile.deviceIdentity.xmtpId,
          turnkeyAddress: profile.deviceIdentity.turnkeyAddress,
        };
      }
    });

    const response: BatchProfilesResponse = {
      profiles: profilesMap,
    };

    res.json(response);
  } catch {
    res.status(500).json({ error: "Failed to fetch profiles" });
  }
};
