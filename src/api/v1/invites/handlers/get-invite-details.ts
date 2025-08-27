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

export type GetAuthenticatedInviteDetailsResponse = {
  id: string;
  name: string | null;
  description: string | null;
  imageUrl: string | null;
  inviteLinkURL: string;
  groupId: string;
  inviterInboxId: string;
};

export const getPublicInviteDetailsHandler = async (
  req: Request,
  res: Response,
) => {
  try {
    const { inviteId } = await paramsSchema.parseAsync(req.params);

    const invite = await prisma.inviteCode.findFirst({
      where: {
        id: inviteId,
        status: "ACTIVE",
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      select: {
        id: true,
        name: true,
        description: true,
        imageUrl: true,
        groupId: true,
      },
    });

    if (!invite) {
      res.status(404).json({
        success: false,
        message: "Invite not found",
      });
      return;
    }

    const response: GetPublicInviteDetailsResponse = {
      id: invite.id,
      name: invite.name,
      description: invite.description,
      imageUrl: invite.imageUrl,
      inviteLinkURL: getInviteLink(invite.id),
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

export const getOwnerInviteDetailsHandler = async (
  req: Request,
  res: Response,
) => {
  try {
    const { inviteId } = await paramsSchema.parseAsync(req.params);

    // Get the authenticated user's identity from the JWT
    const { xmtpId } = req.app.locals;

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

    const invite = await prisma.inviteCode.findUnique({
      where: { id: inviteId },
    });

    if (!invite) {
      res.status(404).json({
        success: false,
        message: "Invite not found",
      });
      return;
    }

    // Only allow the invite creator to see full details
    if (invite.createdById !== identity.id) {
      res.status(403).json({
        success: false,
        message: "Forbidden: you don't have access to this invite",
      });
      return;
    }

    const response: GetInviteDetailsResponse = {
      id: invite.id,
      name: invite.name,
      description: invite.description,
      imageUrl: invite.imageUrl,
      maxUses: invite.maxUses,
      usesCount: invite.usesCount,
      status: invite.status,
      expiresAt: invite.expiresAt ? invite.expiresAt.toISOString() : null,
      autoApprove: invite.autoApprove,
      groupId: invite.groupId,
      createdAt: invite.createdAt.toISOString(),
      inviteLinkURL: getInviteLink(invite.id),
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

export const getAuthenticatedInviteDetailsHandler = async (
  req: Request,
  res: Response,
) => {
  try {
    const { inviteId } = await paramsSchema.parseAsync(req.params);

    // Get the authenticated user's identity from the JWT
    const xmtpId = req.app.locals.xmtpId;

    if (!xmtpId) {
      res.status(404).json({
        success: false,
        message: "Invite not found",
      });
      return;
    }

    const identity = await prisma.deviceIdentity.findFirst({
      where: { xmtpId },
    });

    if (!identity) {
      res.status(404).json({
        success: false,
        message: "Invite not found",
      });
      return;
    }

    const invite = await prisma.inviteCode.findFirst({
      where: {
        id: inviteId,
        status: "ACTIVE",
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      select: {
        id: true,
        name: true,
        description: true,
        imageUrl: true,
        groupId: true,
        createdBy: {
          select: {
            xmtpId: true,
          },
        },
      },
    });

    if (!invite || !invite.createdBy.xmtpId) {
      res.status(404).json({
        success: false,
        message: "Invite not found",
      });
      return;
    }

    const response: GetAuthenticatedInviteDetailsResponse = {
      id: invite.id,
      name: invite.name,
      description: invite.description,
      imageUrl: invite.imageUrl,
      inviteLinkURL: getInviteLink(invite.id),
      groupId: invite.groupId,
      inviterInboxId: invite.createdBy.xmtpId,
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

    req.log.error({ error }, "Authenticated invite details fetch failed");
    res.status(500).json({
      success: false,
      message: "Failed to fetch invite details",
    });
  }
};
