import { Router, type Request, type Response } from "express";
import { createThirdwebClient } from "thirdweb";
import { getSocialProfiles } from "thirdweb/social";
import { z } from "zod";

const lookupRouter = Router();

const FarcasterProfileSchema = z.object({
  fid: z.number().optional(),
  bio: z.string().optional(),
  pfp: z.string().optional(),
  display: z.string().optional(),
  username: z.string().optional(),
  custodyAddress: z.string().optional(),
  addresses: z.array(z.string()).optional(),
});

const LensProfileSchema = z.object({
  name: z.string().optional(),
  bio: z.string().optional(),
  picture: z.string().optional(),
  coverPicture: z.string().optional(),
});

const EnsProfileSchema = z.object({
  name: z.string().optional(),
  address: z.string().optional(),
  avatar: z.string().optional(),
  display: z.string().optional(),
  description: z.string().optional(),
  keywords: z.array(z.string()).optional(),
  email: z.string().optional(),
  mail: z.string().optional(),
  notice: z.string().optional(),
  location: z.string().optional(),
  phone: z.string().optional(),
  url: z.string().optional(),
  twitter: z.string().optional(),
  github: z.string().optional(),
  discord: z.string().optional(),
  telegram: z.string().optional(),
});

// Note: We define our own schema instead of relying on thirdweb's types
// as they may not be up to date with the actual API response.
// This schema is based on actual API responses and excludes metadata
// for simplicity and stability.
const SocialProfileSchema = z
  .object({
    type: z.enum(["farcaster", "lens", "ens"]),
    name: z.string().optional(),
    avatar: z.string().optional(),
    bio: z.string().optional(),
    metadata: z
      .union([FarcasterProfileSchema, LensProfileSchema, EnsProfileSchema])
      .optional(),
  })
  // removes additional properties that may be present in the API response
  .strip();

const SocialProfilesSchema = z.array(SocialProfileSchema);

type ISocialProfiles = z.infer<typeof SocialProfilesSchema>;

type SocialProfilesResponse = {
  socialProfiles: ISocialProfiles;
};

type ErrorResponse = {
  error: string;
};

// Combined response type
type AddressLookupResponse = SocialProfilesResponse | ErrorResponse;

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
  async (
    req: Request<GetAddressLookupRequestParams>,
    res: Response<AddressLookupResponse>,
  ) => {
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

      const validationResult = SocialProfilesSchema.safeParse(sortedProfiles);

      if (!validationResult.success) {
        console.error(
          "Social profiles validation failed:",
          validationResult.error,
        );
      }

      res.json({
        socialProfiles: validationResult.success
          ? validationResult.data
          : sortedProfiles,
      });
    } catch {
      res.status(500).json({
        error: "Failed to lookup address",
      });
    }
  },
);

export default lookupRouter;
