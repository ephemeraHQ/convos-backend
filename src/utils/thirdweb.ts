import { createThirdwebClient } from "thirdweb";
import { getSocialProfiles } from "thirdweb/social";
import { z } from "zod";

const _ProfileType = z.enum([
  "ens",
  "farcaster",
  "basename",
  "lens",
  "unstoppable-domains",
]);

// Note: We define our own schema instead of relying on thirdweb's types
// as they may not be up to date with the actual API response.
const SocialProfileSchema = z
  .object({
    type: z.enum([
      "ens",
      "farcaster",
      "basename",
      "lens",
      "unstoppable-domains",
    ]),
    address: z.string(),
    name: z.string(),
    bio: z.string().optional(),
    avatar: z.string().optional(),
  })
  .strip();

export type SocialProfile = z.infer<typeof SocialProfileSchema>;

// Priority order for profile types
export const ProfileTypePriority: Record<
  z.infer<typeof _ProfileType>,
  number
> = {
  ens: 1,
  farcaster: 2,
  basename: 3,
  lens: 4,
  "unstoppable-domains": 5,
} as const;

let thirdwebClient: ReturnType<typeof createThirdwebClient> | null = null;

/**
 * Gets or creates a ThirdWeb client instance
 */
function getThirdwebClient() {
  if (!process.env.THIRDWEB_SECRET_KEY) {
    throw new Error("THIRDWEB_SECRET_KEY is not set");
  }

  if (!thirdwebClient) {
    thirdwebClient = createThirdwebClient({
      secretKey: process.env.THIRDWEB_SECRET_KEY,
    });
  }

  return thirdwebClient;
}

/**
 * Fetches and validates social profiles for an address
 */
export async function getSocialProfilesForAddress(args: {
  address: string;
  sortByPriority?: boolean;
}): Promise<SocialProfile[]> {
  const client = getThirdwebClient();

  try {
    const profiles = await getSocialProfiles({
      address: args.address,
      client,
    });

    const validatedProfiles = z.array(SocialProfileSchema).parse(profiles);

    if (args.sortByPriority) {
      return validatedProfiles.sort(
        (a, b) => ProfileTypePriority[a.type] - ProfileTypePriority[b.type],
      );
    }

    return validatedProfiles;
  } catch (error) {
    console.error(
      `Error fetching social profiles for address ${args.address}:`,
      error,
    );
    return [];
  }
}

/**
 * Checks if an address owns a specific name across any of their social profiles
 */
export async function checkNameOwnership(args: {
  address: string;
  name: string;
}) {
  const profiles = await getSocialProfilesForAddress({ address: args.address });

  return profiles.some(
    (profile) =>
      profile.name && profile.name.toLowerCase() === args.name.toLowerCase(),
  );
}
