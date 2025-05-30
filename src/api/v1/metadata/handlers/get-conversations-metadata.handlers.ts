import { type Request, type Response } from "express";
import { z } from "zod";
import { prisma } from "@/utils/prisma";

const requestParamsSchema = z.object({
  deviceIdentityId: z.string(),
});

const requestQuerySchema = z.object({
  conversationIds: z.string(), // Comma-separated list of conversation IDs
});

export async function getConversationsMetadataHandler(
  req: Request,
  res: Response,
) {
  try {
    const { deviceIdentityId } = requestParamsSchema.parse(req.params);
    const { conversationIds } = requestQuerySchema.parse(req.query);
    const { xmtpId } = req.app.locals;

    // First check if the device identity exists and belongs to the authenticated user
    const deviceIdentity = await prisma.deviceIdentity.findFirst({
      where: {
        id: deviceIdentityId,
        xmtpId,
      },
    });

    if (!deviceIdentity) {
      res
        .status(403)
        .json({ error: "Not authorized to access this device identity" });
      return;
    }

    const conversationIdArray = conversationIds.split(",");

    // Get all existing metadata records
    const existingMetadata = await prisma.conversationMetadata.findMany({
      where: {
        conversationId: { in: conversationIdArray },
        deviceIdentityId,
      },
    });

    // Find which conversation IDs don't have metadata yet
    const existingConversationIds = existingMetadata.map(
      (m) => m.conversationId,
    );
    const missingConversationIds = conversationIdArray.filter(
      (id) => !existingConversationIds.includes(id),
    );

    // Create metadata for missing conversations
    if (missingConversationIds.length > 0) {
      await prisma.conversationMetadata.createMany({
        data: missingConversationIds.map((conversationId) => ({
          conversationId,
          deviceIdentityId,
        })),
      });

      // Fetch all metadata again to include newly created records
      const allMetadata = await prisma.conversationMetadata.findMany({
        where: {
          conversationId: { in: conversationIdArray },
          deviceIdentityId,
        },
      });

      res.json(allMetadata);
      return;
    }

    res.json(existingMetadata);
  } catch (error) {
    console.error("Failed to fetch or create conversation metadata:", error);
    res
      .status(500)
      .json({ error: "Failed to fetch or create conversation metadata" });
  }
}
