import type { Request, Response } from "express";
import { z } from "zod";
import { prisma } from "@/utils/prisma";

const acceptRequestParams = z.object({
  requestId: z.string().min(1, "Request ID is required"),
});

export type AcceptRequestToJoinParams = z.infer<typeof acceptRequestParams>;

export type AcceptRequestToJoinResponse = {
  id: string;
  accepted: boolean;
  inviteCodeUse: {
    id: string;
    usedAt: string;
  };
};

/**
 * Accept a join request and create an InviteCodeUse record
 * Only the invite creator or notification targets can accept requests
 */
export async function acceptRequestToJoin(req: Request, res: Response) {
  try {
    const params = await acceptRequestParams.parseAsync(req.params);
    const { xmtpId } = res.locals;

    // Find the authenticated user's identity
    const authenticatedIdentity = await prisma.deviceIdentity.findFirst({
      where: { xmtpId },
    });

    if (!authenticatedIdentity) {
      res.status(404).json({
        success: false,
        message: "Request not found",
      });
      return;
    }

    // Load the join request with related entities
    const requestToJoin = await prisma.inviteCodeRequest.findUnique({
      where: { id: params.requestId },
      include: {
        requester: true,
        inviteCode: {
          include: {
            createdBy: true,
            notificationTargets: {
              include: {
                deviceIdentity: true,
              },
            },
          },
        },
      },
    });

    if (!requestToJoin) {
      res.status(404).json({
        success: false,
        message: "Request not found",
      });
      return;
    }

    // Check if user has already been accepted (has InviteCodeUse record)
    const existingUse = await prisma.inviteCodeUse.findUnique({
      where: {
        inviteCodeId_usedById: {
          inviteCodeId: requestToJoin.inviteCodeId,
          usedById: requestToJoin.requesterId,
        },
      },
    });

    if (existingUse) {
      res.status(400).json({
        success: false,
        message: "Request has already been accepted",
      });
      return;
    }

    // Authorization: only invite creator OR notification targets can accept
    const isCreator = requestToJoin.inviteCode.createdBy.xmtpId === xmtpId;
    const isNotificationTarget =
      requestToJoin.inviteCode.notificationTargets.some(
        (target) => target.deviceIdentity.xmtpId === xmtpId,
      );

    if (!isCreator && !isNotificationTarget) {
      res.status(404).json({
        success: false,
        message: "Request not found",
      });
      return;
    }

    // Check if invite is still valid
    const inviteCode = requestToJoin.inviteCode;
    if (inviteCode.status !== "ACTIVE") {
      res.status(400).json({
        success: false,
        message: "Invite is no longer active",
      });
      return;
    }

    if (inviteCode.expiresAt && inviteCode.expiresAt < new Date()) {
      res.status(400).json({
        success: false,
        message: "Invite has expired",
      });
      return;
    }

    // Check max uses limit
    if (inviteCode.maxUses && inviteCode.usesCount >= inviteCode.maxUses) {
      res.status(400).json({
        success: false,
        message: "Invite has reached maximum uses",
      });
      return;
    }

    // Accept the request and create InviteCodeUse in a transaction
    const result = await prisma.$transaction(async (tx) => {
      // Create InviteCodeUse record
      const inviteCodeUse = await tx.inviteCodeUse.create({
        data: {
          inviteCodeId: requestToJoin.inviteCodeId,
          usedById: requestToJoin.requesterId,
        },
      });

      // Increment uses count
      await tx.inviteCode.update({
        where: { id: requestToJoin.inviteCodeId },
        data: {
          usesCount: {
            increment: 1,
          },
        },
      });

      // Delete the original request (it's been processed)
      await tx.inviteCodeRequest.delete({
        where: { id: params.requestId },
      });

      return { inviteCodeUse };
    });

    const response: AcceptRequestToJoinResponse = {
      id: params.requestId,
      accepted: true,
      inviteCodeUse: {
        id: result.inviteCodeUse.id,
        usedAt: result.inviteCodeUse.usedAt.toISOString(),
      },
    };

    res.status(200).json(response);
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({
        success: false,
        message: "Invalid request data",
        errors: error.errors,
      });
      return;
    }

    req.log.error({ error }, "Error accepting request to join");
    res.status(500).json({
      success: false,
      message: "Failed to accept request",
    });
  }
}
