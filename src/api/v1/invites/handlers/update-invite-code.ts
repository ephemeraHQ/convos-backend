import type { InviteCodeStatus } from "@prisma/client";
import type { Request, Response } from "express";
import { z } from "zod";
import { getInviteLink } from "@/utils/invites";
import { prisma } from "@/utils/prisma";
import { InviteCodeStatusSchema } from "../../../../../prisma/generated/zod";

const paramsSchema = z.object({
  inviteId: z.string().min(1, "Invite ID is required"),
});

export const updateInviteCodeRequestBodySchema = z.object({
  groupId: z.string(),
  name: z.string().optional(),
  description: z.string().optional(),
  imageUrl: z.string().url().optional(),
  maxUses: z.number().int().positive().optional(),
  expiresAt: z.string().datetime().optional(),
  autoApprove: z.boolean().default(false),
  notificationTargets: z.array(z.string()).default([]),
  status: InviteCodeStatusSchema.optional(),
});

export type UpdateInviteCodeRequestBody = z.infer<
  typeof updateInviteCodeRequestBodySchema
>;
export type UpdateInviteCodeParams = z.infer<typeof paramsSchema>;

export type UpdateInviteCodeResponse = {
  id: string;
  name: string | null;
  description: string | null;
  imageUrl: string | null;
  maxUses: number | null;
  usesCount: number;
  status: InviteCodeStatus;
  expiresAt: string | null;
  autoApprove: boolean;
  groupId: string;
  createdAt: string;
  inviteLinkURL: string;
};

export async function updateInviteCode(
  req: Request<UpdateInviteCodeParams, unknown, UpdateInviteCodeRequestBody>,
  res: Response,
) {
  try {
    let body;
    let params;

    try {
      body = await updateInviteCodeRequestBodySchema.parseAsync(req.body);
      params = await paramsSchema.parseAsync(req.params);
    } catch (error) {
      if (error instanceof z.ZodError) {
        req.log.error({ error }, "Invalid request data");
        res.status(400).json({
          success: false,
          message: "Invalid request data",
          errors: error.errors,
        });
        return;
      }
      throw error;
    }

    // Get the authenticated user's identity from the JWT
    const { xmtpId } = res.locals;

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

    // Verify the invite exists and belongs to the user
    const existingInvite = await prisma.inviteCode.findUnique({
      where: { id: params.inviteId },
    });

    if (!existingInvite) {
      res.status(404).json({
        success: false,
        message: "Invite not found",
      });
      return;
    }

    if (existingInvite.createdById !== identity.id) {
      res.status(403).json({
        success: false,
        message: "Not authorized to update this invite",
      });
      return;
    }

    // Validate notification targets exist if provided
    let notificationTargetIds: string[] = [];
    if (body.notificationTargets.length > 0) {
      const targetIdentities = await prisma.deviceIdentity.findMany({
        where: {
          xmtpId: {
            in: body.notificationTargets,
          },
        },
        select: {
          id: true,
          xmtpId: true,
        },
      });

      const foundXmtpIds = targetIdentities.map((identity) => identity.xmtpId);
      const missingXmtpIds = body.notificationTargets.filter(
        (xmtpId) => !foundXmtpIds.includes(xmtpId),
      );

      if (missingXmtpIds.length > 0) {
        req.log.warn(
          { missingXmtpIds },
          "Some notification targets not found, skipping them",
        );
      }

      notificationTargetIds = targetIdentities.map((identity) => identity.id);
    }

    // Update the invite code
    const inviteCode = await prisma.$transaction(async (tx) => {
      // Delete existing notification targets
      await tx.inviteCodeNotificationTarget.deleteMany({
        where: { inviteCodeId: params.inviteId },
      });

      // Update the invite code
      const updatedInvite = await tx.inviteCode.update({
        where: { id: params.inviteId },
        data: {
          name: body.name,
          description: body.description,
          imageUrl: body.imageUrl,
          maxUses: body.maxUses,
          expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
          autoApprove: body.autoApprove,
          groupId: body.groupId,
          ...(body.status ? { status: body.status } : {}),
          notificationTargets: {
            create: notificationTargetIds.map((deviceIdentityId) => ({
              deviceIdentityId,
            })),
          },
        },
      });

      return updatedInvite;
    });

    const response: UpdateInviteCodeResponse = {
      id: inviteCode.id,
      name: inviteCode.name,
      description: inviteCode.description,
      imageUrl: inviteCode.imageUrl,
      maxUses: inviteCode.maxUses,
      usesCount: inviteCode.usesCount,
      status: inviteCode.status,
      expiresAt: inviteCode.expiresAt?.toISOString() || null,
      autoApprove: inviteCode.autoApprove,
      groupId: inviteCode.groupId,
      createdAt: inviteCode.createdAt.toISOString(),
      inviteLinkURL: getInviteLink(inviteCode.id),
    };

    res.status(200).json(response);
  } catch (error) {
    req.log.error({ error }, "Error updating invite code");
    res.status(500).json({
      success: false,
      message: "Failed to update invite code",
    });
  }
}
