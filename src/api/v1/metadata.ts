import { PrismaClient } from "@prisma/client";
import {
  Router,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { z } from "zod";

const metadataRouter = Router();
const prisma = new PrismaClient();

type GetMetadataRequestParams = {
  conversationId: string;
  deviceIdentityId: string;
};

// GET /metadata/conversation/:deviceIdentityId/:conversationId - Get conversation metadata by device identity and conversation ID
metadataRouter.get(
  "/conversation/:deviceIdentityId/:conversationId",
  async (
    req: Request<GetMetadataRequestParams>,
    res: Response,
    next: NextFunction,
  ) => {
    try {
      const { conversationId, deviceIdentityId } = req.params;
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

      // Try to find the metadata
      let metadata = await prisma.conversationMetadata.findFirst({
        where: {
          conversationId,
          deviceIdentityId,
        },
      });

      // If not found, create it with default values
      if (!metadata) {
        metadata = await prisma.conversationMetadata.create({
          data: {
            conversationId,
            deviceIdentityId,
            pinned: false,
            unread: true,
            deleted: false,
          },
        });
      }

      res.json(metadata);
    } catch (error) {
      // Forward any errors to the error middleware
      next(error);
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
    next: NextFunction,
  ) => {
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
        },
      });

      res.status(201).json(metadata);
    } catch (error) {
      if (error instanceof z.ZodError) {
        res
          .status(400)
          .json({ error: "Invalid request body", details: error.errors });
        return;
      }
      // Forward any other errors to the error middleware
      next(error);
    }
  },
);

export default metadataRouter;
