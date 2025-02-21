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
 * Same validation rules as the client side:
 * ./features/profiles/profiles.api.ts
 */
export const profileBaseSchema = z.object({
  name: z
    .string()
    .min(3, { message: "Name must be at least 3 characters long" })
    .max(50, { message: "Name cannot exceed 50 characters" })
    .regex(/^[a-zA-Z0-9\s]+$/, {
      message: "Name can only contain letters, numbers and spaces",
    }),
  username: z
    .string()
    .min(3, { message: "Username must be at least 3 characters long" })
    .max(50, { message: "Username cannot exceed 50 characters" })
    .regex(/^[a-zA-Z0-9-]+$/, {
      message: "Username can only contain letters, numbers and dashes",
    }),
  description: z
    .string()
    .max(500, { message: "Description cannot exceed 500 characters" })
    .optional(),
  avatar: z.string().url({ message: "Avatar must be a valid URL" }).optional(),
});

// For creation - name and username required, description and avatar optional
export const profileValidationSchema = profileBaseSchema;

// For updates - all fields optional but maintaining validation rules
export const profileUpdateValidationSchema = profileBaseSchema.partial();

/**
 * Validates profile information
 * @param profileData Profile data to validate
 * @param isUpdate Whether this is an update operation
 * @returns Validation result with any errors
 */
export async function validateProfile(
  profileData: ProfileValidationRequest,
  isUpdate = false,
): Promise<ProfileValidationResponse> {
  const validationResult: ProfileValidationResponse = {
    success: true,
    errors: {},
  };

  // Check for required fields first when creating
  if (!isUpdate) {
    const errors: Record<string, string> = {};
    if (!profileData.name) {
      errors.name = "Name is required";
    }
    if (!profileData.username) {
      errors.username = "Username is required";
    }
    if (Object.keys(errors).length > 0) {
      return {
        success: false,
        errors,
      };
    }
  }

  // Then validate against schema
  try {
    const schema = isUpdate
      ? profileUpdateValidationSchema
      : profileValidationSchema;
    schema.parse(profileData);

    // Check for existing username after schema validation
    if (profileData.username) {
      const existingProfile = await prisma.profile.findFirst({
        where: {
          username: {
            equals: profileData.username,
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

    // If we reach here, all validations passed
    validationResult.message = "Profile information is valid";
    return validationResult;
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
    }
    return validationResult;
  }
}
