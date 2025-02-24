import { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { profileCreationSchema, profileUpdateSchema } from "../profile.schema";
import type {
  ProfileValidationRequest,
  ProfileValidationResponse,
} from "../profile.types";

const prisma = new PrismaClient();

export enum ProfileValidationErrorType {
  USERNAME_TAKEN = "USERNAME_TAKEN",
  INVALID_FORMAT = "INVALID_FORMAT",
  REQUIRED_FIELD = "REQUIRED_FIELD",
}

export type ProfileValidationError = {
  type: ProfileValidationErrorType;
  message: string;
};

/**
 * Checks if a username is already taken
 */
async function checkUsernameTaken(username: string): Promise<boolean> {
  const existingProfile = await prisma.profile.findFirst({
    where: {
      username: {
        equals: username,
        mode: "insensitive",
      },
    },
  });

  return !!existingProfile;
}

/**
 * Validates profile information for creation
 */
export async function validateProfileCreation(args: {
  profileData: ProfileValidationRequest;
}): Promise<ProfileValidationResponse> {
  // Check for required fields first
  const errors: ProfileValidationResponse["errors"] = {};
  if (!args.profileData.name) {
    errors.name = {
      type: ProfileValidationErrorType.REQUIRED_FIELD,
      message: "Name is required",
    };
  }
  if (!args.profileData.username) {
    errors.username = {
      type: ProfileValidationErrorType.REQUIRED_FIELD,
      message: "Username is required",
    };
  }
  if (Object.keys(errors).length > 0) {
    return {
      success: false,
      errors,
    };
  }

  try {
    // Validate against schema
    profileCreationSchema.parse(args.profileData);

    // Check for username uniqueness
    if (
      args.profileData.username &&
      (await checkUsernameTaken(args.profileData.username))
    ) {
      return {
        success: false,
        errors: {
          username: {
            type: ProfileValidationErrorType.USERNAME_TAKEN,
            message: "This username is already taken",
          },
        },
      };
    }

    return {
      success: true,
      message: "Profile information is valid",
    };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return {
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
    }
    throw error;
  }
}

/**
 * Validates profile information for updates
 */
export async function validateProfileUpdate(args: {
  profileData: ProfileValidationRequest;
}): Promise<ProfileValidationResponse> {
  try {
    // Validate against schema
    profileUpdateSchema.parse(args.profileData);

    // Check for username uniqueness if username is being updated
    if (
      args.profileData.username &&
      (await checkUsernameTaken(args.profileData.username))
    ) {
      return {
        success: false,
        errors: {
          username: {
            type: ProfileValidationErrorType.USERNAME_TAKEN,
            message: "This username is already taken",
          },
        },
      };
    }

    return {
      success: true,
      message: "Profile information is valid",
    };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return {
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
    }
    throw error;
  }
}
