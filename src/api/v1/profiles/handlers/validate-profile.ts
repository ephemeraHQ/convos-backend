import { PrismaClient } from "@prisma/client";
import { createThirdwebClient } from "thirdweb";
import { getSocialProfiles } from "thirdweb/social";
import { z } from "zod";
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

  if (existingProfile) {
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
export async function validateOnChainName(
  name: string,
  xmtpId: string,
): Promise<ProfileValidationResponse> {
  try {
    // Validate against schema
    profileCreationSchema.parse(args.profileData);

    // Check for username uniqueness
    if (
      args.profileData.username &&
      (await checkUsernameTaken({ username: args.profileData.username }))
    ) {
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

    // Initialize ThirdWeb client
    if (!process.env.THIRDWEB_SECRET_KEY) {
      throw new Error("THIRDWEB_SECRET_KEY is not set");
    }

    const thirdwebClient = createThirdwebClient({
      secretKey: process.env.THIRDWEB_SECRET_KEY,
    });

    // Check each address for social profiles
    for (const address of addresses) {
      try {
        const profiles = await getSocialProfiles({
          address,
          client: thirdwebClient,
        });

        // Check if any of the social profiles match the name
        const hasMatchingName = profiles.some(
          (profile) =>
            profile.name && profile.name.toLowerCase() === name.toLowerCase(),
        );
        if (hasMatchingName) {
          return { success: true };
        }
      } catch (error) {
        console.error(
          `Error fetching social profiles for address ${address}:`,
          error,
        );
        continue;
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
      console.log("Schema validation passed");
    } catch (parseError) {
      console.log("Schema validation failed:", parseError);
      throw parseError;
    }

    // Check for username uniqueness if username is being updated
    if (
      args.profileData.username &&
      (await checkUsernameTaken({
        username: args.profileData.username,
        excludeProfileId: args.currentProfileId,
      }))
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
