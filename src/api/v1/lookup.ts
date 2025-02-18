import { Router, type Request, type Response } from "express";
import { createThirdwebClient } from "thirdweb";
import { getSocialProfiles } from "thirdweb/social";
import { z } from "zod";

const lookupRouter = Router();

type GetAddressLookupRequestParams = {
  address: string;
};

const ProfileType = z.enum([
  "ens",
  "farcaster",
  "basename",
  "lens",
  "unstoppable-domains",
]);
type ProfileType = z.infer<typeof ProfileType>;

// Note: We define our own schema instead of relying on thirdweb's types
// as they may not be up to date with the actual API response.
// This schema is based on actual API responses and excludes metadata
// for simplicity and stability.
const SocialProfileSchema = z
  .object({
    type: ProfileType,
    address: z.string(),
    name: z.string(),
    bio: z.string().optional(),
    avatar: z.string().optional(),
  })
  // removes additional properties that may be present in the API response
  .strip();

const SocialProfilesResponseSchema = z.array(SocialProfileSchema);

// Priority order for profile types
const ProfileTypePriority: Record<ProfileType, number> = {
  ens: 1,
  farcaster: 2,
  basename: 3,
  lens: 4,
  "unstoppable-domains": 5,
} as const;

// GET /lookup/address/:address - Lookup social profiles by address
lookupRouter.get(
  "/address/:address",
  async (req: Request<GetAddressLookupRequestParams>, res: Response) => {
    try {
      const { address } = req.params;

      if (!process.env.THIRDWEB_SECRET_KEY) {
        throw new Error("THIRDWEB_SECRET_KEY is not set");
      }

      const client = createThirdwebClient({
        secretKey: process.env.THIRDWEB_SECRET_KEY,
      });

      const profiles = await getSocialProfiles({
        address,
        client,
      });

      const validatedProfiles = SocialProfilesResponseSchema.parse(profiles);

      // Sort profiles by priority
      const sortedProfiles = validatedProfiles.sort(
        (a, b) => ProfileTypePriority[a.type] - ProfileTypePriority[b.type],
      );

      res.json(sortedProfiles);
    } catch {
      res.status(500).json({ error: "Failed to lookup address" });
    }
  },
);

export default lookupRouter;
