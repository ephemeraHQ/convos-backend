import { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { checkNameOwnership } from "../../../../utils/thirdweb";
import { getAddressesForInboxId } from "../../../../utils/xmtp";
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
  NAME_TAKEN = "NAME_TAKEN",
  ONCHAIN_NAME_NOT_OWNED = "ONCHAIN_NAME_NOT_OWNED",
}

export type ProfileValidationError = {
  type: ProfileValidationErrorType;
  message: string;
};

/**
 * Validates required fields in profile data
 */
export function validateProfileRequiredFields(
  profileData: ProfileValidationRequest,
): ProfileValidationResponse {
  const errors: ProfileValidationResponse["errors"] = {};

  if (!profileData.name) {
    errors.name = {
      type: ProfileValidationErrorType.REQUIRED_FIELD,
      message: "Name is required",
    };
  }

  if (!profileData.username) {
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

  return { success: true };
}

/**
 * Validates profile data against schema
 */
export function validateProfileSchema(
  profileData: ProfileValidationRequest,
): ProfileValidationResponse {
  try {
    profileCreationSchema.parse(profileData);
    return { success: true };
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
 * Checks if a username is already taken
 */
async function checkUsernameTaken(args: {
  username: string;
  excludeProfileId?: string;
}): Promise<boolean> {
  const existingProfile = await prisma.profile.findFirst({
    where: {
      username: {
        equals: args.username,
        mode: "insensitive",
      },
      // Exclude the profile with the given id if it exists
      ...(args.excludeProfileId ? { id: { not: args.excludeProfileId } } : {}),
    },
  });

  return !!existingProfile;
}

/**
 * Validates username uniqueness
 */
export async function validateUsernameUniqueness(
  username: string,
  excludeProfileId?: string,
): Promise<ProfileValidationResponse> {
  const isTaken = await checkUsernameTaken({
    username,
    excludeProfileId,
  });

  if (isTaken) {
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

  return { success: true };
}

/**
 * Validates ownership of an on-chain name
 */
export async function validateOnChainName(args: {
  name: string;
  xmtpId: string;
}): Promise<ProfileValidationResponse> {
  const { name, xmtpId } = args;

  try {
    const addresses = await getAddressesForInboxId(xmtpId);
    if (addresses.length === 0) {
      return {
        success: false,
        errors: {
          name: {
            type: ProfileValidationErrorType.ONCHAIN_NAME_NOT_OWNED,
            message: "No addresses found for this XMTP ID",
          },
        },
      };
    }

    // Check each address for name ownership
    for (const address of addresses) {
      const isOwner = await checkNameOwnership({ address, name });
      if (isOwner) {
        return { success: true };
      }
    }

    return {
      success: false,
      errors: {
        name: {
          type: ProfileValidationErrorType.ONCHAIN_NAME_NOT_OWNED,
          message: "You don't own this on-chain name",
        },
      },
    };
  } catch (error) {
    console.error("Error verifying on-chain name:", error);
    return {
      success: false,
      errors: {
        name: {
          type: ProfileValidationErrorType.ONCHAIN_NAME_NOT_OWNED,
          message: "Failed to verify on-chain name ownership",
        },
      },
    };
  }
}

/**
 * Validates profile information for updates
 */
export async function validateProfileUpdate(args: {
  profileData: ProfileValidationRequest;
  currentProfileId?: string;
}): Promise<ProfileValidationResponse> {
  try {
    // Validate against schema
    try {
      profileUpdateSchema.parse(args.profileData);
    } catch (parseError) {
      if (parseError instanceof z.ZodError) {
        return {
          success: false,
          errors: parseError.errors.reduce(
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
      throw parseError;
    }

    // Check for username uniqueness if username is being updated
    if (args.profileData.username) {
      const uniquenessResult = await validateUsernameUniqueness(
        args.profileData.username,
        args.currentProfileId,
      );
      if (!uniquenessResult.success) {
        return uniquenessResult;
      }
    }

    return {
      success: true,
      message: "Profile information is valid",
    };
  } catch (error) {
    console.error("Error validating profile update:", error);
    throw error;
  }
}
