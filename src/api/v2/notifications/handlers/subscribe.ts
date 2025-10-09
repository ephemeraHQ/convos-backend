import type { Request, Response } from "express";
import { hexToUint8Array } from "uint8array-extras";
import { z } from "zod";
import { createNotificationClient } from "@/notifications/client";
import { prisma } from "@/utils/prisma";

const subscribeRequestSchema = z.object({
  clientIdentifier: z.string(),
  topics: z.array(
    z.object({
      topic: z.string(),
      hmacKeys: z.array(
        z.object({
          thirtyDayPeriodsSinceEpoch: z.number(),
          key: z.string(),
        }),
      ),
    }),
  ),
});

export type ISubscribeRequestBody = z.infer<typeof subscribeRequestSchema>;

const notificationClient = createNotificationClient();

export async function subscribe(
  req: Request<unknown, unknown, ISubscribeRequestBody>,
  res: Response,
) {
  try {
    const body = subscribeRequestSchema.parse(req.body);

    // Look up client and device
    const client = await prisma.clientIdentifier.findUnique({
      where: { id: body.clientIdentifier },
      include: { device: true },
    });

    if (!client) {
      res.status(404).json({ error: "Client not found" });
      return;
    }

    if (client.device.disabled) {
      res.status(403).json({ error: "Device is disabled" });
      return;
    }

    // Convert HMAC keys to Uint8Array
    const subscriptions = body.topics.map((topic) => ({
      topic: topic.topic,
      isSilent: false,
      hmacKeys: topic.hmacKeys.map((key) => ({
        thirtyDayPeriodsSinceEpoch: key.thirtyDayPeriodsSinceEpoch,
        key: hexToUint8Array(key.key),
      })),
    }));

    // Register installation with notification server
    await notificationClient.registerInstallation({
      installationId: body.clientIdentifier,
      deliveryMechanism: {
        deliveryMechanismType: {
          case:
            client.device.tokenType === "apns"
              ? "apnsDeviceToken"
              : "firebaseDeviceToken",
          value: client.device.pushToken,
        },
      },
    });

    // Subscribe to topics
    await notificationClient.subscribeWithMetadata({
      installationId: body.clientIdentifier,
      subscriptions,
    });

    // Create or update client identifier record
    await prisma.clientIdentifier.upsert({
      where: { id: body.clientIdentifier },
      create: {
        id: body.clientIdentifier,
        deviceId: client.deviceId,
      },
      update: {
        updatedAt: new Date(),
      },
    });

    res.status(200).send();
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Invalid request body" });
      return;
    }
    req.log.error({ error }, "Failed to subscribe to topics");
    res.status(500).json({ error: "Failed to subscribe to topics" });
  }
}
