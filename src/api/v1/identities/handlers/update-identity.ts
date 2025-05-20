import { type Request, type Response } from "express";
import { z } from "zod";
import { prisma } from "@/utils/prisma";

// Schema for creating and updating a device identity
const deviceIdentitySchema = z.object({
  xmtpId: z.string().optional(),
  turnkeyAddress: z.string(),
});

export type UpdateIdentityRequestBody = z.infer<typeof deviceIdentitySchema>;

export type UpdateIdentityRequestParams = {
  identityId: string;
};

// PUT /identities/:identityId - Update an identity
export const updateIdentity = async (
  req: Request<UpdateIdentityRequestParams, unknown, UpdateIdentityRequestBody>,
  res: Response,
) => {
  try {
    const { identityId } = req.params;
    const { xmtpId } = req.app.locals;
    const validatedData = deviceIdentitySchema.parse(req.body);

    // First check if identity belongs to authenticated user
    const existingIdentity = await prisma.deviceIdentity.findFirst({
      where: {
        id: identityId,
        xmtpId,
      },
    });

    if (!existingIdentity) {
      res.status(403).json({ error: "Not authorized to update this identity" });
      return;
    }

    const identity = await prisma.deviceIdentity.update({
      where: { id: identityId },
      data: validatedData,
    });

    res.json(identity);
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Invalid request body" });
      return;
    }
    res.status(500).json({ error: "Failed to update identity" });
  }
};
