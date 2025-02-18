import { PrismaClient } from "@prisma/client";
import { z } from "zod";
import type {
  ProfileValidationRequest,
  ProfileValidationResponse,
} from "./profile.types";

const prisma = new PrismaClient();

/**
 * Schema for profile validation with detailed error messages
 * @description Validates profile information before creation or update
 *
 * @todo: verify with product what requirements are here
 */
export const profileValidationSchema = z.object({
  name: z
    .string()
    .min(3, { message: "Name must be at least 3 characters long" })
    .max(50, { message: "Name cannot exceed 50 characters" })
    .optional(),
  description: z
    .string()
    .max(500, { message: "Description cannot exceed 500 characters" })
    .optional(),
  avatar: z.string().url({ message: "Avatar must be a valid URL" }).optional(),
});

/**
 * Validates profile information
 * @param profileData Profile data to validate
 * @returns Validation result with any errors
 */
export async function validateProfile(
  profileData: ProfileValidationRequest,
): Promise<ProfileValidationResponse> {
  const validationResult: ProfileValidationResponse = {
    success: true,
    errors: {},
  };

  // Check for existing username (case-insensitive) first
  if (profileData.name) {
    const existingProfile = await prisma.profile.findFirst({
      where: {
        name: {
          equals: profileData.name,
          mode: "insensitive",
        },
      },
    });

    if (existingProfile) {
      validationResult.success = false;
      validationResult.errors = {
        username: "This username is already taken",
      };
      return validationResult;
    }
  }

  // Then validate payload against schema
  try {
    profileValidationSchema.parse({ ...profileData });
  } catch (validationError) {
    if (validationError instanceof z.ZodError) {
      validationResult.success = false;
      validationResult.errors = validationError.errors.reduce(
        (acc, error) => ({
          ...acc,
          [error.path[0]]: error.message,
        }),
        {},
      );
      return validationResult;
    }
  }

  // If we reach here, all validations passed
  validationResult.message = "Profile information is valid";
  return validationResult;
}
