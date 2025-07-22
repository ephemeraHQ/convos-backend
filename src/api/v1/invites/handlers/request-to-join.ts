import type { Request, Response } from "express";
import { z } from "zod";
import { prisma } from "@/utils/prisma";

const requestToJoinSchema = z.object({
  inviteId: z.string().min(1, "Invite ID is required"),
});

export type RequestToJoinRequestBody = z.infer<typeof requestToJoinSchema>;

export type RequestToJoinResponse = {
  id: string;
  status: string;
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

    // Check if invite requires approval (if autoApprove is true, they should use a different endpoint)
    if (inviteCode.autoApprove) {
      res.status(400).json({
        success: false,
        message:
          "This invite does not require approval. You can join directly.",
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
        message: `You already have a ${existingRequest.status.toLowerCase()} request for this group`,
      });
      return;
    }

    // Create the request
    const request = await prisma.inviteCodeRequest.create({
      data: {
        inviteCodeId: body.inviteId,
        requesterId: requesterIdentity.id,
        status: "PENDING",
      },
    });

    // Log notification info (no actual notifications sent)
    logRequestNotification({
      requesterName: requesterIdentity.profile?.name,
      requesterXmtpId: requesterIdentity.xmtpId,
      inviteCreatorName: inviteCode.createdBy.profile?.name,
      groupId: inviteCode.groupId,
    });

    const response: RequestToJoinResponse = {
      id: request.id,
      status: request.status,
      inviteId: request.inviteCodeId,
      createdAt: request.createdAt.toISOString(),
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

    req.log.error({ error }, "Error creating join request");
    res.status(500).json({
      success: false,
      message: "Failed to create join request",
    });
  }
}

function logRequestNotification(args: {
  requesterName?: string;
  requesterXmtpId: string;
  inviteCreatorName?: string;
  groupId: string;
}) {
  const { requesterName, requesterXmtpId, inviteCreatorName, groupId } = args;

  console.log("🔔 Join Request Created:");
  console.log(
    `   📧 Would notify invite creator (${inviteCreatorName || "Unknown"})`,
  );
  console.log(
    `   👤 Request from: ${requesterName || "Unknown"} (${requesterXmtpId})`,
  );
  console.log(`   🎫 For group: ${groupId}`);
}
