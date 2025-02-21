import { PrismaClient } from "@prisma/client";
import type { Request, Response } from "express";
import { z } from "zod";
import type { ProfileValidationResponse } from "../profile.types";
import { validateProfile, type profileBaseSchema } from "../profile.validation";
import type { GetProfileRequestParams } from "../profiles.types";

const prisma = new PrismaClient();

// Use Zod schema for type definition
export type UpdateProfileRequestBody = Partial<
  z.infer<typeof profileBaseSchema>
>;

export async function updateProfile(
  req: Request<GetProfileRequestParams, unknown, UpdateProfileRequestBody>,
  res: Response,
) {
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

    // Validate the request body
    const validationResult = await validateProfile(req.body, true);

    if (!validationResult.success) {
      // Only use 409 if the error is specifically about username being taken
      const status =
        validationResult.errors?.username === "This username is already taken"
          ? 409
          : 400;
      res.status(status).json(validationResult);
      return;
    }

    // Update the profile
    const updatedProfile = await prisma.profile.update({
      where: { id: existingProfile.id },
      data: req.body,
    });

    res.json(updatedProfile);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const validationResult: ProfileValidationResponse = {
        success: false,
        errors: error.errors.reduce(
          (acc, err) => ({
            ...acc,
            [err.path[0]]: err.message,
          }),
          {},
        ),
      };
      res.status(400).json(validationResult);
      return;
    }
    res.status(500).json({ error: "Failed to update profile" });
  }
}
