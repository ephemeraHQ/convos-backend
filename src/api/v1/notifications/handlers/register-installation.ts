import type { Request, Response } from "express";
import { z } from "zod";
import { createNotificationClient } from "@/notifications/client";

// Schema for registration
const registrationSchema = z.object({
  installationId: z.string(),
  deliveryMechanism: z.object({
    deliveryMechanismType: z.object({
      case: z.enum(["apnsDeviceToken", "firebaseDeviceToken", "customToken"]),
      value: z.string(),
    }),
  }),
});

type RegisterInstallationRequestBody = z.infer<typeof registrationSchema>;

const notificationClient = createNotificationClient();

export async function registerInstallation(
  req: Request<unknown, unknown, RegisterInstallationRequestBody>,
  res: Response,
) {
  try {
    const validatedData = registrationSchema.parse(req.body);

    const response = await notificationClient.registerInstallation({
      installationId: validatedData.installationId,
      deliveryMechanism: validatedData.deliveryMechanism,
    });

    res.status(201).json({
      installationId: response.installationId,
      validUntil: Number(response.validUntil),
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Invalid request body" });
      return;
    }
    res.status(500).json({ error: "Failed to register installation" });
  }
}
