import { Router, type Request, type Response } from "express";
import { hexToUint8Array } from "uint8array-extras";
import { z } from "zod";
import { createNotificationClient } from "@/notifications/client";

const notificationsRouter = Router();
const notificationClient = createNotificationClient();

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

export type RegisterInstallationRequestBody = z.infer<
  typeof registrationSchema
>;

// POST /notifications/register - Register a new installation
notificationsRouter.post(
  "/register",
  async (
    req: Request<unknown, unknown, RegisterInstallationRequestBody>,
    res: Response,
  ) => {
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
      console.error(error);
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: "Invalid request body" });
        return;
      }
      res.status(500).json({ error: "Failed to register installation" });
    }
  },
);

// Schema for subscription without optional metadata
const subscribeRequestBodySchema = z.object({
  installationId: z.string(),
  topics: z.array(z.string()),
});

export type SubscribeRequestBody = z.infer<typeof subscribeRequestBodySchema>;

// Schema for subscription with optional metadata
const subscribeWithMetadataRequestBodySchema = z.object({
  installationId: z.string(),
  subscriptions: z.array(
    z.object({
      topic: z.string(),
      isSilent: z.boolean().optional().default(false),
      hmacKeys: z.array(
        z.object({
          thirtyDayPeriodsSinceEpoch: z.number(),
          key: z.string(),
        }),
      ),
    }),
  ),
});

export type SubscribeWithMetadataRequestBody = z.infer<
  typeof subscribeWithMetadataRequestBodySchema
>;

// POST /notifications/subscribe - Subscribe to topics with optional metadata
notificationsRouter.post(
  "/subscribe",
  async (
    req: Request<unknown, unknown, SubscribeWithMetadataRequestBody>,
    res: Response,
  ) => {
    try {
      // first check if the request body is a simple subscribe request
      // if parsing fails, check if the request body is a subscribe with metadata request
      try {
        const validatedData = subscribeRequestBodySchema.parse(req.body);
        await notificationClient.subscribe({
          installationId: validatedData.installationId,
          topics: validatedData.topics,
        });
        res.status(200).send();
        return;
      } catch (error) {
        // request was for a simple subscribe, but the client failed to subscribe
        if (!(error instanceof z.ZodError)) {
          res.status(500).json({ error: "Failed to subscribe to topics" });
          return;
        }
      }

      const validatedData = subscribeWithMetadataRequestBodySchema.parse(
        req.body,
      );

      // convert the HMAC keys to Uint8Array from hex strings
      const subscriptions = validatedData.subscriptions.map((sub) => ({
        ...sub,
        hmacKeys: sub.hmacKeys.map((key) => ({
          ...key,
          key: hexToUint8Array(key.key),
        })),
      }));

      await notificationClient.subscribeWithMetadata({
        installationId: validatedData.installationId,
        subscriptions,
      });

      res.status(200).send();
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: "Invalid request body" });
        return;
      }
      res.status(500).json({ error: "Failed to subscribe to topics" });
    }
  },
);

const unsubscribeRequestBodySchema = z.object({
  installationId: z.string(),
  topics: z.array(z.string()),
});

type UnsubscribeRequestBody = z.infer<typeof unsubscribeRequestBodySchema>;

// POST /notifications/unsubscribe - Unsubscribe from topics
notificationsRouter.post(
  "/unsubscribe",
  async (
    req: Request<unknown, unknown, UnsubscribeRequestBody>,
    res: Response,
  ) => {
    try {
      const validatedData = unsubscribeRequestBodySchema.parse(req.body);

      await notificationClient.unsubscribe({
        installationId: validatedData.installationId,
        topics: validatedData.topics,
      });

      res.status(200).send();
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: "Invalid request body" });
        return;
      }
      res.status(500).json({ error: "Failed to unsubscribe from topics" });
    }
  },
);

const unregisterRequestParamsSchema = z.object({
  installationId: z.string(),
});

type UnregisterRequestParams = z.infer<typeof unregisterRequestParamsSchema>;

// DELETE /notifications/unregister/:installationId - Delete an installation
notificationsRouter.delete(
  "/unregister/:installationId",
  async (req: Request<UnregisterRequestParams>, res: Response) => {
    try {
      const validatedData = unregisterRequestParamsSchema.parse(req.params);

      await notificationClient.deleteInstallation({
        installationId: validatedData.installationId,
      });

      res.status(200).send();
    } catch {
      res.status(500).json({ error: "Failed to delete installation" });
    }
  },
);

export default notificationsRouter;
