import type { Request, Response } from "express";
import { z } from "zod";
import { prisma } from "@/utils/prisma";
import { namestoneService } from "../../../../utils/namestone";
import type { profileBaseSchema } from "../profile.schema";
import type { ProfileValidationResponse } from "../profile.types";
import type { GetProfileRequestParams } from "../profiles.types";
import {
  ProfileValidationErrorType,
  validateOnChainName,
  validateProfileUpdate,
} from "./validate-profile";

// Use Zod schema for type definition
export type UpdateProfileRequestBody = Partial<
  z.infer<typeof profileBaseSchema>
>;

export async function updateProfile(
  req: Request<GetProfileRequestParams, unknown, UpdateProfileRequestBody>,
  res: Response,
) {
  try {
    const { xmtpId: targetXmtpId } = req.params;
    const { xmtpId: authenticatedXmtpId } = req.app.locals;

    if (!targetXmtpId) {
      res.status(400).json({ error: "Invalid request parameters" });
      return;
    }

    // First verify if the target device identity exists
    const deviceIdentity = await prisma.deviceIdentity.findFirst({
      where: {
        xmtpId: targetXmtpId,
      },
    });

    if (!deviceIdentity) {
      res.status(404).json({ error: "Device identity not found" });
      return;
    }

    // Check if the authenticated user has access to this profile
    const hasAccess = await prisma.deviceIdentity.findFirst({
      where: {
        xmtpId: authenticatedXmtpId,
        userId: deviceIdentity.userId,
      },
    });

    if (!hasAccess) {
      res.status(403).json({ error: "Not authorized to update this profile" });
      return;
    }

    // Find the profile first to check if it exists
    const existingProfile = await prisma.profile.findFirst({
      where: {
        deviceIdentity: {
          xmtpId: targetXmtpId,
        },
      },
    });

    if (!existingProfile) {
      res.status(404).json({ error: "Profile not found" });
      return;
    }

    // Preprocess the data before validation
    const preprocessedData = { ...req.body };

    // Handle empty strings for optional fields
    if (preprocessedData.avatar === "") {
      preprocessedData.avatar = null;
    }
    if (preprocessedData.description === "") {
      preprocessedData.description = null;
    }

    // Validate the request body
    const validationResult = await validateProfileUpdate({
      profileData: preprocessedData,
      currentProfileId: existingProfile.id,
    });

    if (!validationResult.success) {
      // Get the first error type to determine status code
      const firstError = Object.values(validationResult.errors || {})[0];
      const status =
        firstError.type === ProfileValidationErrorType.USERNAME_TAKEN
          ? 409
          : 400;
      res.status(status).json(validationResult);
      return;
    }

    if (preprocessedData.name?.includes(".")) {
      const onChainResult = await validateOnChainName({
        name: preprocessedData.name,
        xmtpId: targetXmtpId,
      });
      if (!onChainResult.success) {
        res.status(400).json(onChainResult);
        return;
      }
    }

    // Update the profile
    const updatedProfile = await prisma.profile.update({
      where: { id: existingProfile.id },
      data: preprocessedData,
    });

    // Handle Namestone name changes
    const isUsernameChanging =
      preprocessedData.username &&
      preprocessedData.username !== existingProfile.username;

    if (isUsernameChanging) {
      // Delete old name and set new name
      // Don't await to avoid blocking the response
      Promise.all([
        // Delete old username
        namestoneService.deleteName({ username: existingProfile.username }),
        // Set new username
        namestoneService.setName({
          username: updatedProfile.username,
          address: deviceIdentity.turnkeyAddress,
          textRecords: {
            "display.name": updatedProfile.name,
            ...(updatedProfile.description && {
              description: updatedProfile.description,
            }),
            ...(updatedProfile.avatar && { avatar: updatedProfile.avatar }),
          },
        }),
      ]).catch((error: unknown) => {
        // Log error but don't fail profile update
        req.log.error(
          {
            error,
            oldUsername: existingProfile.username,
            newUsername: updatedProfile.username,
            address: deviceIdentity.turnkeyAddress,
          },
          "Failed to update Namestone name during profile update",
        );
      });
    } else if (
      preprocessedData.name ||
      preprocessedData.description ||
      preprocessedData.avatar
    ) {
      // If other profile fields changed but not username, update the text records
      namestoneService
        .setName({
          username: updatedProfile.username,
          address: deviceIdentity.turnkeyAddress,
          textRecords: {
            "display.name": updatedProfile.name,
            ...(updatedProfile.description && {
              description: updatedProfile.description,
            }),
            ...(updatedProfile.avatar && { avatar: updatedProfile.avatar }),
          },
        })
        .catch((error: unknown) => {
          // Log error but don't fail profile update
          req.log.error(
            {
              error,
              username: updatedProfile.username,
              address: deviceIdentity.turnkeyAddress,
            },
            "Failed to update Namestone text records during profile update",
          );
        });
    }

    res.json(updatedProfile);
  } catch (error) {
    console.error("Failed to update profile:", error);
    if (error instanceof z.ZodError) {
      const validationResult: ProfileValidationResponse = {
        success: false,
        errors: error.errors.reduce(
          (acc, err) => ({
            ...acc,
            [err.path[0]]: {
              type: ProfileValidationErrorType.INVALID_FORMAT,
              message: err.message,
            },
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
