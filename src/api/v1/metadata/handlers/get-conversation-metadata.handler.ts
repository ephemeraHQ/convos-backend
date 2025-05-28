import { type Request, type Response } from "express";
import { prisma } from "@/utils/prisma";

export type GetConversationMetadataRequestParams = {
  conversationId: string;
  deviceIdentityId: string;
};

export async function getConversationMetadataHandler(
  req: Request<GetConversationMetadataRequestParams>,
  res: Response,
) {
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
        },
      });
    }

    res.json(metadata);
  } catch (error) {
    console.error("Failed to fetch or create conversation metadata:", error);
    res
      .status(500)
      .json({ error: "Failed to fetch or create conversation metadata" });
  }
}
