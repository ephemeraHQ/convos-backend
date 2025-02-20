import { PrismaClient } from "@prisma/client";
import { Router, type Request, type Response } from "express";
import { z } from "zod";

const metadataRouter = Router();
const prisma = new PrismaClient();

type GetMetadataRequestParams = {
  conversationId: string;
};

// GET /metadata/conversation/:conversationId - Get conversation metadata by conversation ID
metadataRouter.get(
  "/conversation/:conversationId",
  async (req: Request<GetMetadataRequestParams>, res: Response) => {
    try {
      const { conversationId } = req.params;
      const metadata = await prisma.conversationMetadata.findUnique({
        where: { conversationId },
      });

      if (!metadata) {
        res.status(404).json({ error: "Conversation metadata not found" });
        return;
      }

      res.json(metadata);
    } catch {
      res.status(500).json({ error: "Failed to fetch conversation metadata" });
    }
  },
);

const conversationMetadataUpsertSchema = z.object({
  conversationId: z.string(),
  pinned: z.boolean().optional(),
  unread: z.boolean().optional(),
  deleted: z.boolean().optional(),
  readUntil: z.string().datetime().optional(),
  deviceIdentityId: z.string(),
});

type UpsertMetadataRequestBody = z.infer<
  typeof conversationMetadataUpsertSchema
>;

// POST /metadata/conversation - Upsert conversation metadata
metadataRouter.post(
  "/conversation",
  async (
    req: Request<Record<string, never>, unknown, UpsertMetadataRequestBody>,
    res: Response,
  ) => {
    try {
      const validatedData = conversationMetadataUpsertSchema.parse(req.body);

      // Check if device identity exists
      const deviceIdentity = await prisma.deviceIdentity.findUnique({
        where: { id: validatedData.deviceIdentityId },
      });

      if (!deviceIdentity) {
        res.status(404).json({ error: "Device identity not found" });
        return;
      }

      const metadata = await prisma.conversationMetadata.upsert({
        where: { conversationId: validatedData.conversationId },
        create: validatedData,
        update: {
          pinned: validatedData.pinned,
          unread: validatedData.unread,
          deleted: validatedData.deleted,
          readUntil: validatedData.readUntil,
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
  },
);

export default metadataRouter;
