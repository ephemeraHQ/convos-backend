import type { InviteCodeStatus } from "@prisma/client";
import type { Request, Response } from "express";
import { z } from "zod";
import { prisma } from "@/utils/prisma";

export const createInviteCodeRequestBodySchema = z.object({
  groupId: z.string(),
  name: z.string().optional(),
  description: z.string().optional(),
  imageUrl: z.string().url().optional(),
  maxUses: z.number().int().positive().optional(),
  expiresAt: z.string().datetime().optional(),
  autoApprove: z.boolean().default(false),
});

export type CreateInviteCodeRequestBody = z.infer<
  typeof createInviteCodeRequestBodySchema
>;

export type CreateInviteCodeResponse = {
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

function getInviteLink(inviteId: string): string {
  return `${process.env.WEBSITE_URL}/join/${inviteId}`;
}

export async function createInviteCode(
  req: Request<unknown, unknown, CreateInviteCodeRequestBody>,
  res: Response,
) {
  try {
    let body;
    try {
      body = await createInviteCodeRequestBodySchema.parseAsync(req.body);
    } catch (error) {
      if (error instanceof z.ZodError) {
        req.log.error({ error }, "Invalid request body");
        res.status(400).json({
          success: false,
          message: "Invalid request body",
          errors: error.errors,
        });
        return;
      }
      throw error;
    }

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

    // Create the invite code
    const inviteCode = await prisma.inviteCode.create({
      data: {
        name: body.name,
        description: body.description,
        imageUrl: body.imageUrl,
        maxUses: body.maxUses,
        expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
        autoApprove: body.autoApprove,
        groupId: body.groupId,
        createdById: identity.id,
      },
    });

    const response: CreateInviteCodeResponse = {
      id: inviteCode.id, // This cuid serves as the invite code for /join/INVITECODE
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

    res.status(201).json(response);
  } catch (error) {
    req.log.error({ error }, "Error creating invite code");
    res.status(500).json({
      success: false,
      message: "Failed to create invite code",
    });
  }
}
