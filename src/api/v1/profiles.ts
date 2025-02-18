import { PrismaClient } from "@prisma/client";
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { validateProfile } from "./profiles/profile.validation";
import { profileUpdateSchema } from "./profiles/profiles.router";

export const profilesRouter = Router();
const prisma = new PrismaClient();

type GetProfileRequestParams = {
  xmtpId: string;
};

type UpdateProfileRequestBody = z.infer<typeof profileUpdateSchema>;

// PUT /profiles/:xmtpId - Update a profile
profilesRouter.put(
  "/:xmtpId",
  // @ts-expect-error generic typescript crap
  async (
    req: Request<GetProfileRequestParams, unknown, UpdateProfileRequestBody>,
    res: Response,
  ) => {
    try {
      const { xmtpId } = req.params;

      if (!xmtpId) {
        res.status(400).json({ error: "Invalid request body" });
        return;
      }

      // Find the profile first to check if it exists
      const existingProfile = await prisma.profile.findFirst({
        where: {
          deviceIdentity: {
            xmtpId: xmtpId,
          },
        },
      });

      if (!existingProfile) {
        res.status(404).json({ error: "Profile not found" });
        return;
      }

      // Parse the request body
      const validatedData = profileUpdateSchema.partial().parse(req.body);

      // Validate the profile data
      // Only check uniqueness if name is being changed
      const validationResult = await validateProfile(validatedData);

      if (!validationResult.success) {
        return res
          .status(validationResult.errors?.username ? 409 : 400)
          .json(validationResult);
      }

      // Update the profile
      const updatedProfile = await prisma.profile.update({
        where: { id: existingProfile.id },
        data: validatedData,
      });

      res.json(updatedProfile);
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: "Invalid request body" });
        return;
      }
      res.status(500).json({ error: "Failed to update profile" });
    }
  },
);
