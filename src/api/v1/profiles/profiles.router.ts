import { PrismaClient, type Profile } from "@prisma/client";
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { ProfileValidationResponse } from "./profile.types";
import { validateProfile } from "./profile.validation";

const profilesRouter = Router();
const prisma = new PrismaClient();

type GetProfileRequestParams = {
  xmtpId: string;
};

type SearchProfilesQuery = {
  query: string;
};

export type SearchProfilesResult = Pick<
  Profile,
  "id" | "name" | "description"
> & {
  xmtpId: string;
};

// Define validation request type

// GET /profiles/search - Search profiles by name
profilesRouter.get(
  "/search",
  async (
    req: Request<unknown, unknown, unknown, SearchProfilesQuery>,
    res: Response,
  ) => {
    try {
      const query = req.query.query || "";
      const trimmedQuery = query.trim();

      if (trimmedQuery.length === 0) {
        res.status(400).json({ error: "Invalid search query" });
        return;
      }

      const profiles = await prisma.profile.findMany({
        where: {
          name: {
            contains: trimmedQuery,
            mode: "insensitive",
          },
          deviceIdentity: {
            xmtpId: {
              not: null,
            },
          },
        },
        select: {
          id: true,
          name: true,
          description: true,
          deviceIdentity: {
            select: {
              xmtpId: true,
            },
          },
        },
        take: 50,
      });

      res.json(
        profiles.map(
          (profile) =>
            ({
              id: profile.id,
              name: profile.name,
              description: profile.description,
              xmtpId: profile.deviceIdentity.xmtpId ?? "",
            }) satisfies SearchProfilesResult,
        ),
      );
    } catch {
      res.status(500).json({ error: "Failed to search profiles" });
    }
  },
);

// GET /profiles/:xmtpId - Get a single profile by XMTP inbox ID
profilesRouter.get(
  "/:xmtpId",
  async (req: Request<GetProfileRequestParams>, res: Response) => {
    try {
      const { xmtpId } = req.params;

      if (!xmtpId) {
        res.status(400).json({ error: "Invalid request body" });
        return;
      }

      const profile = await prisma.profile.findFirst({
        where: {
          deviceIdentity: {
            xmtpId: xmtpId,
          },
        },
      });

      if (!profile) {
        res.status(404).json({ error: "Profile not found" });
        return;
      }

      res.json(profile);
    } catch {
      res.status(500).json({ error: "Failed to fetch profile" });
    }
  },
);

// Schema for creating a profile
export const profileCreateSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  avatar: z.string().url().optional(),
});

type CreateProfileRequestParams = {
  xmtpId: string;
};

export type CreateProfileRequestBody = z.infer<typeof profileCreateSchema>;

// POST /profiles/:xmtpId - Create a new profile
profilesRouter.post(
  "/:xmtpId",
  async (
    req: Request<CreateProfileRequestParams, unknown, CreateProfileRequestBody>,
    res: Response,
  ) => {
    try {
      const { xmtpId } = req.params;
      const validatedData = profileCreateSchema.parse(req.body);

      // Check if device identity exists
      const deviceIdentity = await prisma.deviceIdentity.findFirst({
        where: { xmtpId: xmtpId },
      });

      if (!deviceIdentity) {
        res.status(404).json({ error: "Device identity not found" });
        return;
      }

      // Check if profile already exists for this device identity
      const existingProfile = await prisma.profile.findUnique({
        where: { deviceIdentityId: deviceIdentity.id },
      });

      // Return 409 Conflict status code since this is a conflict with an existing resource
      // A device identity can only have one profile, so creating a second one would conflict
      if (existingProfile) {
        res
          .status(409)
          .json({ error: "Profile already exists for this device identity" });
        return;
      }

      const profile = await prisma.profile.create({
        data: {
          ...validatedData,
          deviceIdentityId: deviceIdentity.id,
        },
      });

      res.status(201).json(profile);
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: "Invalid request body" });
        return;
      }
      res.status(500).json({ error: "Failed to create profile" });
    }
  },
);

// Schema for updating a profile
export const profileUpdateSchema = z.object({
  name: z.string(),
  description: z.string(),
  avatar: z.string().url().optional(),
});

export type UpdateProfileRequestBody = Partial<
  z.infer<typeof profileUpdateSchema>
>;

// PUT /profiles/:xmtpId - Update a profile
profilesRouter.put(
  "/:xmtpId",
  // @ts-expect-error generic typescript crap
  async (
    req: Request<GetProfileRequestParams, unknown, UpdateProfileRequestBody>,
    res: Response,
  ) => {
    try {
      const { xmtpId } = req.params;

      if (!xmtpId) {
        res.status(400).json({ error: "Invalid request body" });
        return;
      }

      // Find the profile first to check if it exists
      const existingProfile = await prisma.profile.findFirst({
        where: {
          deviceIdentity: {
            xmtpId: xmtpId,
          },
        },
      });

      if (!existingProfile) {
        res.status(404).json({ error: "Profile not found" });
        return;
      }

      // Parse the request body and validate it
      const validatedData = profileUpdateSchema.partial().parse(req.body);
      const validationResult = await validateProfile(validatedData);

      if (!validationResult.success) {
        return res
          .status(validationResult.errors?.username ? 409 : 400)
          .json(validationResult);
      }

      // Update the profile
      const updatedProfile = await prisma.profile.update({
        where: { id: existingProfile.id },
        data: validatedData,
      });

      res.json(updatedProfile);
    } catch (error) {
      if (error instanceof z.ZodError) {
        // Convert Zod error to our validation format
        const validationResult: ProfileValidationResponse = {
          success: false,
          errors: error.errors.reduce(
            (acc, err) => ({
              ...acc,
              [err.path[0]]: err.message,
            }),
            {},
          ),
        };
        res.status(400).json(validationResult);
        return;
      }
      res.status(500).json({ error: "Failed to update profile" });
    }
  },
);

type CheckUsernameParams = {
  username: string;
};

type CheckUsernameResponse =
  | {
      taken: boolean;
    }
  | {
      error: string;
    };

// GET /profiles/check/:username - Check if a username is taken
profilesRouter.get(
  "/check/:username",
  async (
    req: Request<CheckUsernameParams>,
    res: Response<CheckUsernameResponse>,
  ) => {
    try {
      const { username } = req.params;
      console.log(req.params);

      console.log(`Checking if username '${username}' is taken`);

      if (!username || username.trim().length === 0) {
        console.log("Username is empty or only whitespace");
        res.status(400).json({ error: "Username is required" });
        return;
      }

      // Find the profile through case-insensitive username match
      const profile = await prisma.profile.findFirst({
        where: {
          name: {
            equals: username,
            mode: "insensitive",
          },
        },
      });

      console.log(
        profile
          ? `Found existing profile with username '${profile.name}'`
          : `No profile found with username '${username}'`,
      );

      res.json({
        taken: !!profile,
      });
    } catch {
      res.status(500).json({ error: "Failed to check username" });
    }
  },
);

export default profilesRouter;
