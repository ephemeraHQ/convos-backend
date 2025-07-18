import type { InviteCodeStatus } from "@prisma/client";
import type { Request, Response } from "express";
import { z } from "zod";
import { getInviteLink } from "@/utils/invites";
import { prisma } from "@/utils/prisma";

const paramsSchema = z.object({
  inviteId: z.string().min(1, "Invite ID is required"),
});

export type GetInviteDetailsResponse = {
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

export type GetPublicInviteDetailsResponse = {
  id: string;
  name: string | null;
  description: string | null;
  imageUrl: string | null;
  inviteLinkURL: string;
};

export const getInviteDetailsHandler = async (req: Request, res: Response) => {
  try {
    const { inviteId } = await paramsSchema.parseAsync(req.params);

    const inviteCode = await prisma.inviteCode.findUnique({
      where: { id: inviteId },
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
      res.status(404).json({
        success: false,
        message: "Invite not found",
      });
      return;
    }

    const response: GetPublicInviteDetailsResponse = {
      id: inviteCode.id,
      name: inviteCode.name,
      description: inviteCode.description,
      imageUrl: inviteCode.imageUrl,
      inviteLinkURL: getInviteLink(inviteCode.id),
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

    req.log.error({ error }, "Error fetching invite details");
    res.status(500).json({
      success: false,
      message: "Failed to fetch invite details",
    });
  }
};
