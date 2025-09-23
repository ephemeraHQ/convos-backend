import type { InviteCodeStatus, Prisma } from "@prisma/client";
import type { Request, Response } from "express";
import { z } from "zod";
import { getInviteLink } from "@/utils/invites";
import { prisma } from "@/utils/prisma";
import { InviteCodeStatusSchema } from "../../../../../prisma/generated/zod";

/**
 * Checks if a user can update group metadata.
 * Allows both the creator of the specific invite being updated and users with valid InviteCodeUse
 */
async function checkCanUpdateGroupMetadata(args: {
  tx: Prisma.TransactionClient;
  identityId: string;
  groupId: string;
  inviteId: string;
}) {
  const { tx, identityId, groupId, inviteId } = args;

  const hasCreatedThisInvite = await tx.inviteCode.findFirst({
    where: {
      id: inviteId,
      groupId,
      createdById: identityId,
    },
  });

  if (hasCreatedThisInvite) {
    return true;
  }

  const hasValidUse = await tx.inviteCodeUse.findFirst({
    where: {
      usedById: identityId,
      inviteCode: {
        groupId: groupId,
      },
    },
  });

  return !!hasValidUse;
}

const paramsSchema = z.object({
  inviteId: z.string().min(1, "Invite ID is required"),
});

export const updateInviteCodeRequestBodySchema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  imageUrl: z.string().url().optional(),
  maxUses: z.number().int().positive().optional(),
  expiresAt: z.string().datetime().optional(),
  autoApprove: z.boolean().optional(),
  notificationTargets: z.array(z.string()).optional(),
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

    const canUpdate = await checkCanUpdateGroupMetadata({
      tx: prisma,
      identityId: identity.id,
      groupId: existingInvite.groupId,
      inviteId: params.inviteId,
    });

    if (!canUpdate) {
      res.status(403).json({
        success: false,
        message: "Not authorized to update this invite",
      });
      return;
    }

    // Validate notification targets exist if provided
    let notificationTargetIds: string[] = [];
    if (body.notificationTargets && body.notificationTargets.length > 0) {
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
      // Delete existing notification targets if new ones are provided
      if (body.notificationTargets !== undefined) {
        await tx.inviteCodeNotificationTarget.deleteMany({
          where: { inviteCodeId: params.inviteId },
        });
      }

      // Check authorization for metadata updates
      const canUpdateMetadata = await checkCanUpdateGroupMetadata({
        tx,
        identityId: identity.id,
        groupId: existingInvite.groupId, // Use groupId from existing invite
        inviteId: params.inviteId,
      });

      // Build metadata update if authorized and fields provided
      if (
        canUpdateMetadata &&
        (body.name !== undefined ||
          body.description !== undefined ||
          body.imageUrl !== undefined)
      ) {
        const metadataUpdate = Object.fromEntries(
          Object.entries({
            name: body.name,
            description: body.description,
            imageUrl: body.imageUrl,
          }).filter(([_, value]) => value !== undefined),
        );

        await tx.groupMetadata.upsert({
          where: { id: existingInvite.groupId },
          update: metadataUpdate,
          create: {
            id: existingInvite.groupId,
            name: body.name,
            description: body.description,
            imageUrl: body.imageUrl,
          },
        });
      }

      // Build update object with only provided fields
      const fieldsToUpdate = {
        maxUses: body.maxUses,
        autoApprove: body.autoApprove,
        status: body.status,
        ...(body.expiresAt !== undefined && {
          expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
        }),
      };

      const updateData = {
        ...Object.fromEntries(
          Object.entries(fieldsToUpdate).filter(
            ([_, value]) => value !== undefined,
          ),
        ),
        // Handle notification targets if provided
        ...(body.notificationTargets !== undefined && {
          notificationTargets: {
            create: notificationTargetIds.map((deviceIdentityId) => ({
              deviceIdentityId,
            })),
          },
        }),
      };

      // Update the invite code
      const updatedInvite = await tx.inviteCode.update({
        where: { id: params.inviteId },
        data: updateData,
        include: {
          groupMetadata: true,
        },
      });

      return updatedInvite;
    });

    const response: UpdateInviteCodeResponse = {
      id: inviteCode.id,
      name: inviteCode.groupMetadata.name ?? null,
      description: inviteCode.groupMetadata.description ?? null,
      imageUrl: inviteCode.groupMetadata.imageUrl ?? null,
      maxUses: inviteCode.maxUses,
      usesCount: inviteCode.usesCount,
      status: inviteCode.status,
      expiresAt: inviteCode.expiresAt
        ? inviteCode.expiresAt.toISOString()
        : null,
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
