import { PrismaClient, type Profile } from "@prisma/client";
import { Router, type Request, type Response } from "express";
import { z } from "zod";

const profilesRouter = Router();
const prisma = new PrismaClient();

type GetProfileRequestParams = {
  xmtpInboxId: string;
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

// GET /profiles/username/valid - Check if a username is available
profilesRouter.get(
  "/username/valid",
  async (
    req: Request<unknown, unknown, unknown, { username: string }>,
    res: Response,
  ) => {
    try {
      const { username } = req.query;

      if (!username || username.trim().length === 0) {
        res.status(400).json({
          success: false,
          message: "Username is required",
        });
        return;
      }

      // Check if username exists
      const existingProfile = await prisma.profile.findFirst({
        where: {
          name: username,
        },
      });

      if (existingProfile) {
        res.json({
          success: false,
          message: "Username is already taken",
        });
        return;
      }

      res.json({
        success: true,
        message: "Username is available",
      });
    } catch {
      res.status(500).json({
        success: false,
        message: "Failed to check username availability",
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
      const query = req.query.query.trim();

      if (query.length === 0) {
        res.status(400).json({ error: "Invalid search query" });
        return;
      }

      const profiles = await prisma.profile.findMany({
        where: {
          name: {
            contains: query,
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
              // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
              xmtpId: profile.deviceIdentity.xmtpId!,
            }) satisfies SearchProfilesResult,
        ),
      );
    } catch {
      res.status(500).json({ error: "Failed to search profiles" });
    }
  },
);

// GET /profiles/:xmtpInboxId - Get a single profile by XMTP inbox ID
profilesRouter.get(
  "/:xmtpInboxId",
  async (req: Request<GetProfileRequestParams>, res: Response) => {
    try {
      const { xmtpInboxId } = req.params;

      if (!xmtpInboxId) {
        res.status(400).json({ error: "Invalid request body" });
        return;
      }

      const profile = await prisma.profile.findFirst({
        where: {
          deviceIdentity: {
            xmtpId: xmtpInboxId,
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
const profileCreateSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
});

type CreateProfileRequestParams = {
  xmtpInboxId: string;
};

export type CreateProfileRequestBody = z.infer<typeof profileCreateSchema>;

// POST /profiles/:xmtpInboxId - Create a new profile
profilesRouter.post(
  "/:xmtpInboxId",
  async (
    req: Request<CreateProfileRequestParams, unknown, CreateProfileRequestBody>,
    res: Response,
  ) => {
    try {
      const { xmtpInboxId } = req.params;
      const validatedData = profileCreateSchema.parse(req.body);

      // Check if device identity exists
      const deviceIdentity = await prisma.deviceIdentity.findFirst({
        where: { xmtpId: xmtpInboxId },
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
const profileUpdateSchema = z.object({
  name: z.string(),
  description: z.string(),
});

export type UpdateProfileRequestBody = Partial<
  z.infer<typeof profileUpdateSchema>
>;

// PUT /profiles/:xmtpInboxId - Update a profile
profilesRouter.put(
  "/:xmtpInboxId",
  async (
    req: Request<GetProfileRequestParams, unknown, UpdateProfileRequestBody>,
    res: Response,
  ) => {
    try {
      const { xmtpInboxId } = req.params;

      if (!xmtpInboxId) {
        res.status(400).json({ error: "Invalid request body" });
        return;
      }

      const validatedData = profileUpdateSchema.partial().parse(req.body);

      // Find the profile through the device identity's xmtpId
      const profile = await prisma.profile.findFirst({
        where: {
          deviceIdentity: {
            xmtpId: xmtpInboxId,
          },
        },
      });

      if (!profile) {
        res.status(404).json({ error: "Profile not found" });
        return;
      }

      const updatedProfile = await prisma.profile.update({
        where: { id: profile.id },
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
