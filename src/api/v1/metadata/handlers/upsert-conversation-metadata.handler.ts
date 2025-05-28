import { type Request, type Response } from "express";
import { z } from "zod";
import { prisma } from "@/utils/prisma";

const conversationMetadataUpsertSchema = z.object({
  conversationId: z.string(),
  pinned: z.boolean().optional(),
  unread: z.boolean().optional(),
  deleted: z.boolean().optional(),
  readUntil: z.string().datetime().optional(),
  muted: z.boolean().optional(),
  deviceIdentityId: z.string(),
});

export type UpsertConversationMetadataRequestBody = z.infer<
  typeof conversationMetadataUpsertSchema
>;

export async function upsertConversationMetadataHandler(
  req: Request<
    Record<string, never>,
    unknown,
    UpsertConversationMetadataRequestBody
  >,
  res: Response,
) {
  try {
    const validatedData = conversationMetadataUpsertSchema.parse(req.body);
    const { xmtpId } = req.app.locals;

    // Check if device identity exists and belongs to the authenticated user
    const deviceIdentity = await prisma.deviceIdentity.findFirst({
      where: {
        id: validatedData.deviceIdentityId,
        xmtpId,
      },
    });

    if (!deviceIdentity) {
      res
        .status(403)
        .json({ error: "Not authorized to access this device identity" });
      return;
    }

    const metadata = await prisma.conversationMetadata.upsert({
      where: {
        deviceIdentityId_conversationId: {
          deviceIdentityId: validatedData.deviceIdentityId,
          conversationId: validatedData.conversationId,
        },
      },
      create: validatedData,
      update: {
        pinned: validatedData.pinned,
        unread: validatedData.unread,
        deleted: validatedData.deleted,
        readUntil: validatedData.readUntil,
        muted: validatedData.muted,
      },
    });

    res.status(201).json(metadata);
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Invalid request body" });
      return;
    }
    res.status(500).json({ error: "Failed to upsert conversation metadata" });
  }
}
