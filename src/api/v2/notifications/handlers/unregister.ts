import type { Request, Response } from "express";
import { z } from "zod";
import { createNotificationClient } from "@/notifications/client";
import { prisma } from "@/utils/prisma";

const unregisterParamsSchema = z.object({
  clientId: z.string().uuid(),
});

export type IUnregisterParams = z.infer<typeof unregisterParamsSchema>;

const notificationClient = createNotificationClient();

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
    });

    if (!client) {
      req.log.warn(
        { clientId: params.clientId },
        "Client not found for unregister",
      );
      res.status(404).json({ error: "Client not found" });
      return;
    }

    // For JWT auth, verify the token's deviceId owns this client
    const jwtDeviceId = res.locals.deviceId as string | undefined;
    if (jwtDeviceId && jwtDeviceId !== client.deviceId) {
      req.log.warn(
        { jwtDeviceId, clientDeviceId: client.deviceId },
        "JWT deviceId mismatch - possible token misuse",
      );
      res.status(403).json({ error: "Device ID mismatch" });
      return;
    }

    try {
      await notificationClient.deleteInstallation({
        installationId: params.clientId,
      });

      await prisma.clientIdentifier.delete({
        where: { id: params.clientId },
      });

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
