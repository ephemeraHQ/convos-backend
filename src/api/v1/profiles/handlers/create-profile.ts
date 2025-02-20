import { PrismaClient } from "@prisma/client";
import type { Request, Response } from "express";
import { z } from "zod";
import type { GetProfileRequestParams } from "../profiles.types";

const prisma = new PrismaClient();

export const profileCreateSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  avatar: z.string().url().optional(),
});

export type CreateProfileRequestBody = z.infer<typeof profileCreateSchema>;

export async function createProfile(
  req: Request<GetProfileRequestParams, unknown, CreateProfileRequestBody>,
  res: Response,
) {
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
}
