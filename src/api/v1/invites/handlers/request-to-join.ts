import type { Request, Response } from "express";
import { z } from "zod";
import { prisma } from "@/utils/prisma";
import type { InviteJoinRequestNotificationData } from "../../notifications/services/notifications-types";
import { getPushNotificationService } from "../../notifications/services/push-notification.service";

const requestToJoinSchema = z.object({
  inviteId: z.string().min(1, "Invite ID is required"),
});

export type RequestToJoinRequestBody = z.infer<typeof requestToJoinSchema>;

export type RequestToJoinResponse = {
  id: string;
  inviteId: string;
  createdAt: string;
};

export async function requestToJoin(
  req: Request<unknown, unknown, RequestToJoinRequestBody>,
  res: Response,
) {
  try {
    const body = await requestToJoinSchema.parseAsync(req.body);
    const { xmtpId } = req.app.locals;

    const pushNotificationService = getPushNotificationService();

    // Find the requester's identity
    const requesterIdentity = await prisma.deviceIdentity.findFirst({
      where: { xmtpId },
      include: { profile: true },
    });

    if (!requesterIdentity) {
      res.status(404).json({
        success: false,
        message: "Identity not found",
      });
      return;
    }

    // Find the invite code
    const inviteCode = await prisma.inviteCode.findUnique({
      where: { id: body.inviteId },
      include: {
        createdBy: {
          include: {
            profile: true,
          },
        },
        notificationTargets: {
          include: {
            deviceIdentity: true,
          },
        },
      },
    });

    if (!inviteCode) {
      res.status(404).json({
        success: false,
        message: "Invite not found",
      });
      return;
    }

    // Check if invite is active
    if (inviteCode.status !== "ACTIVE") {
      res.status(404).json({
        success: false,
        message: "Invite not found",
      });
      return;
    }

    // Check if invite is expired
    if (inviteCode.expiresAt && inviteCode.expiresAt < new Date()) {
      res.status(400).json({
        success: false,
        message: "Invite has expired",
      });
      return;
    }

    // Check if user already has a pending/accepted request
    const existingRequest = await prisma.inviteCodeRequest.findUnique({
      where: {
        inviteCodeId_requesterId: {
          inviteCodeId: body.inviteId,
          requesterId: requesterIdentity.id,
        },
      },
    });

    if (existingRequest) {
      res.status(409).json({
        success: false,
        message: `You already have a request for this group`,
      });
      return;
    }

    // Create the request and return populated relations
    const requestToJoin = await prisma.inviteCodeRequest.create({
      data: {
        inviteCodeId: body.inviteId,
        requesterId: requesterIdentity.id,
      },
      include: {
        requester: {
          include: { profile: true },
        },
        inviteCode: {
          select: {
            id: true,
            name: true,
            description: true,
            groupId: true,
            autoApprove: true,
            createdBy: {
              select: {
                xmtpId: true,
              },
            },
          },
        },
      },
    });

    const payload: InviteJoinRequestNotificationData = {
      id: requestToJoin.id,
      createdAt: requestToJoin.createdAt.toISOString(),
      updatedAt: requestToJoin.updatedAt.toISOString(),
      requester: {
        id: requestToJoin.requester.id,
        xmtpId: requestToJoin.requester.xmtpId,
        profile: requestToJoin.requester.profile
          ? {
              name: requestToJoin.requester.profile.name,
              username: requestToJoin.requester.profile.username,
              description: requestToJoin.requester.profile.description,
              avatar: requestToJoin.requester.profile.avatar,
            }
          : null,
      },
      inviteCode: {
        id: requestToJoin.inviteCode.id,
        name: requestToJoin.inviteCode.name,
        description: requestToJoin.inviteCode.description,
        groupId: requestToJoin.inviteCode.groupId,
      },
      autoApprove: requestToJoin.inviteCode.autoApprove,
    };

    // Collect all recipients (creator + notification targets)
    const allRecipientIds = [
      requestToJoin.inviteCode.createdBy.xmtpId,
      ...inviteCode.notificationTargets.map(
        (target) => target.deviceIdentity.xmtpId,
      ),
    ];

    // Filter out falsy values and deduplicate while preserving order
    const uniqueRecipients = Array.from(
      new Set(allRecipientIds.filter((xmtpId) => xmtpId)),
    );

    // Send notifications to all recipients
    uniqueRecipients.forEach((xmtpId) => {
      pushNotificationService
        .sendPushNotificationToXmtpId({
          xmtpId,
          notification: {
            inboxId: xmtpId,
            notificationType: "InviteJoinRequest",
            notificationData: payload,
          },
        })
        .catch((e: unknown) => {
          req.log.error({ error: e }, "Error sending push notification");
        });
    });

    const response: RequestToJoinResponse = {
      id: requestToJoin.id,
      inviteId: requestToJoin.inviteCodeId,
      createdAt: requestToJoin.createdAt.toISOString(),
    };

    res.status(201).json(response);
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({
        success: false,
        message: "Invalid request body",
        errors: error.errors,
      });
      return;
    }
    req.log.warn(`ERROR DEBUGGING : ${error as string}`);

    req.log.error({ error }, "Error creating join request");
    res.status(500).json({
      success: false,
      message: "Failed to create join request",
    });
  }
}
