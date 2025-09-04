import type { Request, Response } from "express";
import { z } from "zod";
import { prisma } from "@/utils/prisma";

const querySchema = z.object({
  groupId: z.string().optional(),
});

export type GetInviteRequestsQuery = z.infer<typeof querySchema>;

export interface InviteRequestItem {
  id: string;
  createdAt: string;
  updatedAt: string;
  requester: {
    id: string;
    xmtpId: string;
    profile: {
      name: string | null;
      username: string | null;
      description: string | null;
      avatar: string | null;
    } | null;
  };
  inviteCode: {
    id: string;
    name: string | null;
    description: string | null;
    groupId: string;
  };
}

export interface GetInviteRequestsResponse {
  requests: InviteRequestItem[];
  total: number;
}

export async function getInviteRequests(
  req: Request<unknown, unknown, unknown, GetInviteRequestsQuery>,
  res: Response,
) {
  try {
    const query = await querySchema.parseAsync(req.query);
    const { xmtpId } = res.locals;

    // Find the authenticated user's identity
    const identity = await prisma.deviceIdentity.findFirst({
      where: { xmtpId },
    });

    if (!identity) {
      res.status(404).json({
        success: false,
        message: "Identity not found",
      });
      return;
    }

    // Build the where clause for filtering
    const whereClause = {
      inviteCode: {
        createdById: identity.id,
        ...(query.groupId && { groupId: query.groupId }),
      },
    };

    // Get the requests for invite codes created by this user
    const requests = await prisma.inviteCodeRequest.findMany({
      where: whereClause,
      include: {
        requester: {
          include: {
            profile: true,
          },
        },
        inviteCode: {
          select: {
            id: true,
            name: true,
            description: true,
            groupId: true,
          },
        },
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    const response: GetInviteRequestsResponse = {
      requests: requests.map((request) => ({
        id: request.id,
        createdAt: request.createdAt.toISOString(),
        updatedAt: request.updatedAt.toISOString(),
        requester: {
          id: request.requester.id,
          xmtpId: request.requester.xmtpId,
          profile: request.requester.profile
            ? {
                name: request.requester.profile.name,
                username: request.requester.profile.username,
                description: request.requester.profile.description,
                avatar: request.requester.profile.avatar,
              }
            : null,
        },
        inviteCode: {
          id: request.inviteCode.id,
          name: request.inviteCode.name,
          description: request.inviteCode.description,
          groupId: request.inviteCode.groupId,
        },
      })),
      total: requests.length,
    };

    res.status(200).json(response);
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({
        success: false,
        message: "Invalid query parameters",
        errors: error.errors,
      });
      return;
    }

    req.log.error({ error }, "Error fetching invite requests");
    res.status(500).json({
      success: false,
      message: "Failed to fetch invite requests",
    });
  }
}
