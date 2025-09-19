import type { Request, Response } from "express";
import { z } from "zod";
import { prisma } from "@/utils/prisma";

const deleteInviteParamsSchema = z.object({
  inviteId: z.string().min(1, "Invite ID is required"),
});

export type DeleteInviteParams = z.infer<typeof deleteInviteParamsSchema>;

export type DeleteInviteResponse = {
  id: string;
  deleted: boolean;
};

export async function deleteInvite(req: Request, res: Response) {
  try {
    const params = await deleteInviteParamsSchema.parseAsync(req.params);

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

    // Fetch the invite to ensure it exists and is owned by the user
    const invite = await prisma.inviteCode.findUnique({
      where: { id: params.inviteId },
    });

    if (!invite) {
      res.status(404).json({
        success: false,
        message: "Invite not found",
      });
      return;
    }

    if (invite.createdById !== identity.id) {
      res.status(403).json({
        success: false,
        message: "Not authorized to delete this invite",
      });
      return;
    }

    // Delete the invite and clean up orphaned group metadata
    await prisma.$transaction(async (tx) => {
      // Delete the invite code
      await tx.inviteCode.delete({ where: { id: params.inviteId } });

      // Check if this was the last invite for this group
      const remainingInvites = await tx.inviteCode.count({
        where: { groupId: invite.groupId },
      });

      // If no more invites exist for this group, delete the metadata
      if (remainingInvites === 0) {
        await tx.groupMetadata.delete({
          where: { id: invite.groupId },
        });
      }
    });

    const response: DeleteInviteResponse = {
      id: params.inviteId,
      deleted: true,
    };

    res.status(200).json(response);
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({
        success: false,
        message: "Invalid invite ID",
        errors: error.errors,
      });
      return;
    }

    req.log.error({ error }, "Error deleting invite");
    res.status(500).json({
      success: false,
      message: "Failed to delete invite",
    });
  }
}
