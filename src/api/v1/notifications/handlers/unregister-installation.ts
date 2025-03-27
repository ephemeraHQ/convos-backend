import type { Request, Response } from "express";
import { z } from "zod";
import { createNotificationClient } from "@/notifications/client";

// Schema for unregistration
const unregisterRequestParamsSchema = z.object({
  installationId: z.string(),
});

type UnregisterRequestParams = z.infer<typeof unregisterRequestParamsSchema>;

const notificationClient = createNotificationClient();

export async function unregisterInstallation(
  req: Request<UnregisterRequestParams>,
  res: Response,
) {
  try {
    const validatedData = unregisterRequestParamsSchema.parse(req.params);

    await notificationClient.deleteInstallation({
      installationId: validatedData.installationId,
    });

    res.status(200).send();
  } catch {
    res.status(500).json({ error: "Failed to delete installation" });
  }
}
