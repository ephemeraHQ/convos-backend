import type { Request, Response } from "express";
import { z } from "zod";
import { createNotificationClient } from "@/notifications/client";
import { prisma } from "@/utils/prisma";

const unsubscribeRequestSchema = z.object({
  clientId: z.string().min(1).max(255),
  topics: z.array(z.string()).min(1).max(100),
});

export type IUnsubscribeRequestBody = z.infer<typeof unsubscribeRequestSchema>;

const notificationClient = createNotificationClient();

export async function unsubscribe(
  req: Request<unknown, unknown, IUnsubscribeRequestBody>,
  res: Response,
) {
  try {
    const body = unsubscribeRequestSchema.parse(req.body);

    req.log.info(
      { clientId: body.clientId, topicCount: body.topics.length },
      "Unsubscribing from topics",
    );

    // Look up client
    const client = await prisma.clientIdentifier.findUnique({
      where: { id: body.clientId },
    });

    if (!client) {
      req.log.warn(
        { clientId: body.clientId },
        "Client not found for unsubscribe",
      );
      res.status(404).json({ error: "Client not found" });
      return;
    }

    // Unsubscribe from topics
    await notificationClient.unsubscribe({
      installationId: body.clientId,
      topics: body.topics,
    });

    req.log.info({ clientId: body.clientId }, "Unsubscribed successfully");
    res.status(200).send();
    return;
  } catch (error) {
    if (error instanceof z.ZodError) {
      req.log.warn(
        { errors: error.errors },
        "Invalid request body for unsubscribe",
      );
      res.status(400).json({ error: "Invalid request body" });
      return;
    }
    req.log.error({ error }, "Failed to unsubscribe from topics");
    res.status(500).json({ error: "Failed to unsubscribe from topics" });
    return;
  }
}
