import type { Request, Response } from "express";
import { z } from "zod";
import { createNotificationClient } from "@/notifications/client";
import { prisma } from "@/utils/prisma";

const unsubscribeRequestSchema = z.object({
  clientIdentifier: z.string(),
  topics: z.array(z.string()),
});

export type IUnsubscribeRequestBody = z.infer<
  typeof unsubscribeRequestSchema
>;

const notificationClient = createNotificationClient();

export async function unsubscribe(
  req: Request<unknown, unknown, IUnsubscribeRequestBody>,
  res: Response,
) {
  try {
    const body = unsubscribeRequestSchema.parse(req.body);

    // Look up client
    const client = await prisma.clientIdentifier.findUnique({
      where: { id: body.clientIdentifier },
    });

    if (!client) {
      res.status(404).json({ error: "Client not found" });
      return;
    }

    // Unsubscribe from topics
    await notificationClient.unsubscribe({
      installationId: body.clientIdentifier,
      topics: body.topics,
    });

    res.status(200).send();
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Invalid request body" });
      return;
    }
    req.log.error({ error }, "Failed to unsubscribe from topics");
    res.status(500).json({ error: "Failed to unsubscribe from topics" });
  }
}
