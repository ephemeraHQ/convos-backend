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

const unregisterParamsSchema = z.object({
  clientId: z.string().uuid(),
});

export type IUnregisterParams = z.infer<typeof unregisterParamsSchema>;

type UnregisterNotificationClient = Pick<
  ReturnType<typeof createNotificationClient>,
  "deleteInstallation"
>;
let notificationClient: UnregisterNotificationClient =
  createNotificationClient();

export const __setUnregisterNotificationClientForTests = (
  client: UnregisterNotificationClient | null,
): void => {
  notificationClient = client ?? createNotificationClient();
};
let beforeMutationFenceForTests: (() => Promise<void>) | null = null;
export const __setUnregisterBeforeMutationFenceForTests = (
  hook: (() => Promise<void>) | null,
): void => {
  beforeMutationFenceForTests = hook;
};

export async function unregister(
  req: Request<IUnregisterParams>,
  res: Response,
) {
  try {
    const params = unregisterParamsSchema.parse(req.params);

    req.log.info({ clientId: params.clientId }, "Unregistering client");

    // Look up client
    const client = await prisma.clientIdentifier.findUnique({
      where: { id: params.clientId },
      include: { device: { select: { accountId: true } } },
    });

    if (!client) {
      req.log.warn(
        { clientId: params.clientId },
        "Client not found for unregister",
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

    try {
      const generation: InstallationGeneration = {
        accountId: client.accountId,
        deviceAccountId: client.device.accountId,
        deviceId: client.deviceId,
        updatedAt: client.updatedAt,
      };
      const result = await withInstallationMutationFence({
        installationId: params.clientId,
        expectation: { state: "present", generation },
        mutate: async (tx) => {
          await notificationClient.deleteInstallation(
            { installationId: params.clientId },
            notificationMutationCallOptions(),
          );
          await tx.clientIdentifier.deleteMany({
            where: {
              id: params.clientId,
              accountId: generation.accountId,
              deviceId: generation.deviceId,
              updatedAt: generation.updatedAt,
            },
          });
        },
      });
      if (!result.applied) {
        req.log.info(
          { clientId: params.clientId },
          "notifications.unregister.superseded",
        );
      }

      req.log.info(
        { clientId: params.clientId },
        "Successfully cleaned up v2 client",
      );
      res.status(200).send();
      return;
    } catch (cleanupError) {
      req.log.error(
        { error: cleanupError, clientId: params.clientId },
        "Failed to cleanup v2 notification subscriptions during unregister()",
      );
      throw cleanupError;
    }
  } catch (error) {
    if (error instanceof z.ZodError) {
      req.log.warn(
        { errors: error.errors },
        "Invalid request parameters for unregister",
      );
      res.status(400).json({ error: "Invalid request parameters" });
      return;
    }
    req.log.error({ error }, "Failed to unregister client");
    res.status(500).json({ error: "Failed to unregister client" });
    return;
  }
}
