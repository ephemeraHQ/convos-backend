import type { Request, Response } from "express";
import { z } from "zod";
import { createNotificationClient } from "@/notifications/client";
import {
  notificationMutationCallOptions,
  withInstallationMutationFence,
  type InstallationGeneration,
} from "@/notifications/installation-mutation-fence";
import { verifyDeviceOwnership } from "@/utils/auth-guards";
import { prisma } from "@/utils/prisma";

const unsubscribeRequestSchema = z.object({
  clientId: z.string().uuid(),
  topics: z.array(z.string()).min(1).max(100),
});

export type IUnsubscribeRequestBody = z.infer<typeof unsubscribeRequestSchema>;

type UnsubscribeNotificationClient = Pick<
  ReturnType<typeof createNotificationClient>,
  "unsubscribe"
>;
let notificationClient: UnsubscribeNotificationClient =
  createNotificationClient();

export const __setUnsubscribeNotificationClientForTests = (
  client: UnsubscribeNotificationClient | null,
): void => {
  notificationClient = client ?? createNotificationClient();
};
let beforeMutationFenceForTests: (() => Promise<void>) | null = null;
export const __setUnsubscribeBeforeMutationFenceForTests = (
  hook: (() => Promise<void>) | null,
): void => {
  beforeMutationFenceForTests = hook;
};

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
      include: { device: { select: { accountId: true } } },
    });

    if (!client) {
      req.log.warn(
        { clientId: body.clientId },
        "Client not found for unsubscribe",
      );
      res.status(404).json({ error: "Client not found" });
      return;
    }

    // Verify the JWT token's deviceId owns this client
    if (
      !verifyDeviceOwnership({
        req,
        res,
        jwtDeviceId: res.locals.deviceId,
        expectedDeviceId: client.deviceId,
      })
    ) {
      return;
    }
    await beforeMutationFenceForTests?.();

    const generation: InstallationGeneration = {
      accountId: client.accountId,
      deviceAccountId: client.device.accountId,
      deviceId: client.deviceId,
      updatedAt: client.updatedAt,
    };
    const result = await withInstallationMutationFence({
      installationId: body.clientId,
      expectation: { state: "present", generation },
      mutate: () =>
        notificationClient.unsubscribe(
          { installationId: body.clientId, topics: body.topics },
          notificationMutationCallOptions(),
        ),
    });
    if (!result.applied) {
      req.log.info(
        { clientId: body.clientId },
        "notifications.unsubscribe.superseded",
      );
    }

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
