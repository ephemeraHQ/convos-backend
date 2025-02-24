import { PrismaClient } from "@prisma/client";
import { z } from "zod";
import type {
  ProfileValidationRequest,
  ProfileValidationResponse,
} from "./profile.types";

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
 */
export async function validateProfile(args: {
  profileData: ProfileValidationRequest;
  isUpdate?: boolean;
}): Promise<ProfileValidationResponse> {
  const validationResult: ProfileValidationResponse = {
    success: true,
    errors: {},
  };

  // Check for required fields first when creating
  if (!args.isUpdate) {
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
  }

  // Then validate against schema
  try {
    const schema = args.isUpdate
      ? profileUpdateValidationSchema
      : profileValidationSchema;
    schema.parse(args.profileData);

    // Check for existing username after schema validation
    if (args.profileData.username) {
      const existingProfile = await prisma.profile.findFirst({
        where: {
          username: {
            equals: args.profileData.username,
            mode: "insensitive",
          },
        },
      });

      if (existingProfile) {
        validationResult.success = false;
        validationResult.errors = {
          username: {
            type: ProfileValidationErrorType.USERNAME_TAKEN,
            message: "This username is already taken",
          },
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
          [error.path[0]]: {
            type: ProfileValidationErrorType.INVALID_FORMAT,
            message: error.message,
          },
        }),
        {},
      );
    }
    return validationResult;
  }
}
