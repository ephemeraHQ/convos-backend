import { PrismaClient, type Profile } from "@prisma/client";
import { Router, type Request, type Response } from "express";
import { z } from "zod";

const profilesRouter = Router();
const prisma = new PrismaClient();

type GetProfileRequestParams = {
  id: string;
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

// Define validation response type
export type ProfileValidationResponse = {
  success: boolean;
  errors?: {
    username?: string;
    description?: string;
    name?: string;
  };
  message?: string;
};

// Define validation request type
type ProfileValidationRequest = Partial<Pick<Profile, "name" | "description">>;

// Define query parameters type for validation endpoint
type ProfileValidationQueryParams = {
  username?: string;
};

/**
 * Schema for profile validation with detailed error messages
 * @description Validates profile information before creation or update
 *
 * @todo: verify with product what requirements are here
 */
const profileValidationSchema = z.object({
  name: z
    .string()
    .min(3, { message: "Name must be at least 3 characters long" })
    .max(50, { message: "Name cannot exceed 50 characters" })
    .optional(),
  description: z
    .string()
    .max(500, { message: "Description cannot exceed 500 characters" })
    .optional(),
  username: z
    .string()
    .min(3, { message: "Username must be at least 3 characters long" })
    .max(30, { message: "Username cannot exceed 30 characters" })
    .regex(/^[a-zA-Z0-9]+$/, {
      message: "Username can only contain letters and numbers",
    })
    .optional(),
});

/**
 * POST /profiles/validate - Validate profile information
 * @description Validates profile information before creation or update
 * @param {ProfileValidationRequest} req.body - Profile information to validate
 * @returns {ProfileValidationResponse} Validation result with any errors
 */
profilesRouter.post(
  "/validate",
  async (
    req: Request<
      unknown,
      ProfileValidationResponse,
      ProfileValidationRequest,
      ProfileValidationQueryParams
    >,
    res: Response<ProfileValidationResponse>,
  ) => {
    try {
      const { username } = req.query;
      const profileData = req.body;

      const validationResult: ProfileValidationResponse = {
        success: true,
        errors: {},
      };

      // Check for existing username (case-insensitive) first
      if (username) {
        const existingProfile = await prisma.profile.findFirst({
          where: {
            name: {
              equals: username,
              mode: "insensitive",
            },
          },
        });

        if (existingProfile) {
          validationResult.success = false;
          validationResult.errors = {
            username: "This username is already taken",
          };
          return res.status(409).json(validationResult);
        }
      }

      // Then validate payload against schema
      try {
        profileValidationSchema.parse({ ...profileData, username });
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
          return res.status(400).json(validationResult);
        }
      }

      // If we reach here, all validations passed
      validationResult.message = "Profile information is valid";
      return res.status(200).json(validationResult);
    } catch (error) {
      console.error("Profile validation error:", error);
      return res.status(500).json({
        success: false,
        message: "An error occurred while validating profile information",
      });
    }
  },
);

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

// GET /profiles/:id - Get a single profile by ID
profilesRouter.get(
  "/:id",
  async (req: Request<GetProfileRequestParams>, res: Response) => {
    try {
      const { id } = req.params;
      const profile = await prisma.profile.findUnique({
        where: { id },
        include: {
          deviceIdentity: true,
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
});

type CreateProfileRequestParams = {
  deviceIdentityId: string;
};

export type CreateProfileRequestBody = z.infer<typeof profileCreateSchema>;

// POST /profiles/:deviceIdentityId - Create a new profile
profilesRouter.post(
  "/:deviceIdentityId",
  async (
    req: Request<CreateProfileRequestParams, unknown, CreateProfileRequestBody>,
    res: Response,
  ) => {
    try {
      const { deviceIdentityId } = req.params;
      const validatedData = profileCreateSchema.parse(req.body);

      // Check if device identity exists
      const deviceIdentity = await prisma.deviceIdentity.findUnique({
        where: { id: deviceIdentityId },
      });

      if (!deviceIdentity) {
        res.status(404).json({ error: "Device identity not found" });
        return;
      }

      // Check if profile already exists for this device identity
      const existingProfile = await prisma.profile.findUnique({
        where: { deviceIdentityId: deviceIdentityId },
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
          deviceIdentityId,
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
});

export type UpdateProfileRequestBody = Partial<
  z.infer<typeof profileUpdateSchema>
>;

// PUT /profiles/:id - Update a profile
profilesRouter.put(
  "/:id",
  async (
    req: Request<GetProfileRequestParams, unknown, UpdateProfileRequestBody>,
    res: Response,
  ) => {
    try {
      const { id } = req.params;

      const profile = await prisma.profile.findUnique({
        where: { id },
      });

      if (!profile) {
        res.status(404).json({ error: "Profile not found" });
        return;
      }

      const validatedData = profileUpdateSchema.partial().parse(req.body);

      const updatedProfile = await prisma.profile.update({
        where: { id },
        data: validatedData,
      });

      res.json(updatedProfile);
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: "Invalid request body" });
        return;
      }
      res.status(500).json({ error: "Failed to update profile" });
    }
  },
);

export default profilesRouter;
