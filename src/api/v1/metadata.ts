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

type CreateMetadataRequestParams = {
  deviceIdentityId: string;
};

const conversationMetadataCreateSchema = z.object({
  conversationId: z.string(),
  pinned: z.boolean().optional(),
  unread: z.boolean().optional(),
  deleted: z.boolean().optional(),
  readUntil: z.string().datetime().optional(),
});

type CreateMetadataRequestBody = z.infer<
  typeof conversationMetadataCreateSchema
>;

// POST /metadata/conversation/:deviceIdentityId - Create new conversation metadata
metadataRouter.post(
  "/conversation/:deviceIdentityId",
  async (
    req: Request<
      CreateMetadataRequestParams,
      unknown,
      CreateMetadataRequestBody
    >,
    res: Response,
  ) => {
    try {
      const { deviceIdentityId } = req.params;

      // Check if device identity exists
      const deviceIdentity = await prisma.deviceIdentity.findUnique({
        where: { id: deviceIdentityId },
      });

      if (!deviceIdentity) {
        res.status(404).json({ error: "Device identity not found" });
        return;
      }

      const validatedData = conversationMetadataCreateSchema.parse(req.body);

      const metadata = await prisma.conversationMetadata.create({
        data: {
          ...validatedData,
          deviceIdentityId,
        },
      });

      res.status(201).json(metadata);
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: "Invalid request body" });
        return;
      }
      res.status(500).json({ error: "Failed to create conversation metadata" });
    }
  },
);

const conversationMetadataUpdateSchema = z.object({
  pinned: z.boolean().optional(),
  unread: z.boolean().optional(),
  deleted: z.boolean().optional(),
  readUntil: z.string().datetime().optional(),
});

type UpdateMetadataRequestBody = z.infer<
  typeof conversationMetadataUpdateSchema
>;

// PUT /metadata/conversation/:conversationId - Update conversation metadata
metadataRouter.put(
  "/conversation/:conversationId",
  async (
    req: Request<GetMetadataRequestParams, unknown, UpdateMetadataRequestBody>,
    res: Response,
  ) => {
    try {
      const { conversationId } = req.params;
      const validatedData = conversationMetadataUpdateSchema.parse(req.body);

      const metadata = await prisma.conversationMetadata.update({
        where: { conversationId },
        data: validatedData,
      });

      res.json(metadata);
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: "Invalid request body" });
        return;
      }
      res.status(500).json({ error: "Failed to update conversation metadata" });
    }
  },
);

export default metadataRouter;
