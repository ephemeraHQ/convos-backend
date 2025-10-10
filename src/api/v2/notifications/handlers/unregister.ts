import type { Request, Response } from "express";
import { z } from "zod";
import { createNotificationClient } from "@/notifications/client";
import { prisma } from "@/utils/prisma";

const unregisterParamsSchema = z.object({
  clientIdentifier: z.string(),
});

export type IUnregisterParams = z.infer<typeof unregisterParamsSchema>;

const notificationClient = createNotificationClient();

export async function unregister(
  req: Request<IUnregisterParams>,
  res: Response,
) {
  try {
    const params = unregisterParamsSchema.parse(req.params);

    // Look up client
    const client = await prisma.clientIdentifier.findUnique({
      where: { id: params.clientIdentifier },
    });

    if (!client) {
      res.status(404).json({ error: "Client not found" });
      return;
    }

    try {
      await notificationClient.deleteInstallation({
        installationId: params.clientIdentifier,
      });

      await prisma.clientIdentifier.delete({
        where: { id: params.clientIdentifier },
      });

      req.log.info(
        { clientId: params.clientIdentifier },
        "Successfully cleaned up v2 client",
      );
      res.status(200).send();
    } catch (cleanupError) {
      req.log.error(
        { error: cleanupError, clientId: params.clientIdentifier },
        "Failed to cleanup v2 notification subscriptions during unregister()",
      );
      throw cleanupError;
    }
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Invalid request parameters" });
      return;
    }
    req.log.error({ error }, "Failed to unregister client");
    res.status(500).json({ error: "Failed to unregister client" });
  }
}
