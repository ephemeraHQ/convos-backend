import type { Request, Response } from "express";
import { hexToUint8Array } from "uint8array-extras";
import { z } from "zod";
import { createNotificationClient } from "@/notifications/client";
import { prisma } from "@/utils/prisma";

const subscribeRequestSchema = z.object({
  deviceId: z.string().min(1).max(255),
  clientId: z.string().min(1).max(255),
  topics: z
    .array(
      z.object({
        topic: z.string(),
        hmacKeys: z.array(
          z.object({
            thirtyDayPeriodsSinceEpoch: z.number(),
            key: z.string().regex(/^[0-9a-fA-F]+$/, "Invalid hex string"),
          }),
        ),
      }),
    )
    .min(1)
    .max(100),
});

export type ISubscribeRequestBody = z.infer<typeof subscribeRequestSchema>;

const notificationClient = createNotificationClient();

export async function subscribe(
  req: Request<unknown, unknown, ISubscribeRequestBody>,
  res: Response,
) {
  try {
    const body = subscribeRequestSchema.parse(req.body);

    req.log.info(
      {
        deviceId: body.deviceId,
        clientId: body.clientId,
        topicCount: body.topics.length,
      },
      "Subscribing to topics",
    );

    // Verify device exists and is not disabled
    const device = await prisma.deviceRegistration.findUnique({
      where: { deviceId: body.deviceId },
    });

    if (!device) {
      req.log.warn(
        { deviceId: body.deviceId },
        "Device not found for subscribe",
      );
      res.status(404).json({ error: "Device not found" });
      return;
    }

    if (device.disabled) {
      req.log.warn({ deviceId: body.deviceId }, "Device is disabled");
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
    try {
      await notificationClient.registerInstallation({
        installationId: body.clientId,
        deliveryMechanism: {
          deliveryMechanismType: {
            case:
              device.pushTokenType === "apns"
                ? "apnsDeviceToken"
                : "firebaseDeviceToken",
            value: device.pushToken,
          },
        },
      });

      // Subscribe to topics
      await notificationClient.subscribeWithMetadata({
        installationId: body.clientId,
        subscriptions,
      });
    } catch (remoteErr) {
      // Compensate: best-effort delete installation to avoid orphaned state
      try {
        await notificationClient.deleteInstallation({
          installationId: body.clientId,
        });
      } catch (cleanupErr) {
        req.log.warn(
          { error: cleanupErr, installationId: body.clientId },
          "Failed to cleanup installation after subscription failure",
        );
      }
      throw remoteErr;
    }

    // Create or update client identifier record
    try {
      await prisma.clientIdentifier.upsert({
        where: { id: body.clientId },
        create: {
          id: body.clientId,
          deviceId: body.deviceId,
        },
        // Refresh updatedAt by updating deviceId
        update: { deviceId: body.deviceId },
      });
    } catch (dbErr) {
      // Compensate: delete installation to maintain consistency
      try {
        await notificationClient.deleteInstallation({
          installationId: body.clientId,
        });
      } catch (cleanupErr) {
        req.log.warn(
          { error: cleanupErr, installationId: body.clientId },
          "Failed to cleanup installation after DB failure",
        );
      }
      throw dbErr;
    }

    req.log.info(
      { deviceId: body.deviceId, clientId: body.clientId },
      "Subscribed successfully",
    );
    res.status(200).send();
  } catch (error) {
    if (error instanceof z.ZodError) {
      req.log.warn(
        { errors: error.errors, body: req.body },
        "Invalid request body for subscribe",
      );
      res.status(400).json({
        error: "Invalid request body",
        details: error.errors,
        hint: "topics must be an array of objects with { topic: string, hmacKeys: [{ thirtyDayPeriodsSinceEpoch: number, key: string }] }",
      });
      return;
    }
    req.log.error({ error }, "Failed to subscribe to topics");
    res.status(500).json({ error: "Failed to subscribe to topics" });
  }
}
