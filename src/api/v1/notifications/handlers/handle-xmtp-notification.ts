import type { Request, Response } from "express";
import {
  createNotificationClient,
  type WebhookNotificationBody,
} from "@/notifications/client";
import { getHttpDeliveryNotificationAuthHeader } from "@/notifications/utils";
import { prisma } from "@/utils/prisma";
import { getPushNotificationService } from "../services/push-notification.service";

const notificationClient = createNotificationClient();
const pushNotificationService = getPushNotificationService();

if (!process.env.XMTP_NOTIFICATION_SECRET) {
  throw new Error("XMTP_NOTIFICATION_SECRET is not set");
}

/**
 * Webhook handler for XMTP notifications
 *
 * This endpoint uses custom header-based authentication instead of the standard authMiddleware.
 * It validates the request using the XMTP_NOTIFICATION_SECRET to verify the webhook is coming
 * from the authorized XMTP server.
 */
export async function handleXmtpNotification(req: Request, res: Response) {
  let identityOnDeviceToCleanup: {
    xmtpInstallationId: string | null;
    deviceId: string;
  } | null = null;

  try {
    const notification = req.body as WebhookNotificationBody;

    // Log the notification for debugging
    req.log.info(
      {
        contentTopic: notification.message.content_topic,
        installationId: notification.installation.id,
      },
      "received notification",
    );

    // Verify the authorization header
    const authHeader = req.headers.authorization;
    const expectedAuthHeader = getHttpDeliveryNotificationAuthHeader();

    if (!authHeader || authHeader !== expectedAuthHeader) {
      req.log.error("Invalid or missing authorization header");
      res.status(401).json({
        error: "Unauthorized: Invalid authentication token",
      });
      return;
    }

    // Check if this notification should trigger a push
    if (!notification.message_context.should_push) {
      res.status(200).end();
      return;
    }

    const identityOnDevice = await prisma.identitiesOnDevice.findUnique({
      where: {
        xmtpInstallationId: notification.installation.id,
      },
      include: {
        device: true,
        identity: true,
      },
    });

    if (!identityOnDevice || !identityOnDevice.xmtpInstallationId) {
      req.log.error(
        `IdentityOnDevice not found for xmtpInstallationId ${notification.installation.id}`,
      );
      res.status(400).json({
        error: `IdentityOnDevice not found for xmtpInstallationId ${notification.installation.id}`,
      });
      return;
    }

    identityOnDeviceToCleanup = {
      xmtpInstallationId: identityOnDevice.xmtpInstallationId,
      deviceId: identityOnDevice.deviceId,
    };

    const { device, identity } = identityOnDevice;
    const pushTokenType = device.pushTokenType;

    // For APNS (new Convos architecture for OTR), use xmtpId - no identityAddress needed
    if (pushTokenType === "apns") {
      // Use the unified push notification service - xmtpId used internally
      const result = await pushNotificationService.sendPushNotification({
        device,
        notification,
        inboxId: identity.xmtpId,
        req,
      });

      if (!result.success && result.shouldCleanup) {
        req.log.info(
          `Push notification failed with unrecoverable error for device ${device.id}. Initiating cleanup.`,
        );
        if (identityOnDeviceToCleanup.xmtpInstallationId) {
          await cleanupFailedInstallation({
            xmtpInstallationId: identityOnDeviceToCleanup.xmtpInstallationId,
            deviceId: identityOnDeviceToCleanup.deviceId,
            req,
          });
        }
      }

      res.status(200).end();
      return;
    }

    res.status(400).json({ error: "Only APNS notifications supported" });
  } catch (error) {
    req.log.error({ error }, "Outer error processing notification");
    res.status(500).json({ error: "Internal server error" });
  }
}

async function cleanupFailedInstallation(args: {
  xmtpInstallationId: string;
  deviceId: string;
  req: Request;
}) {
  const { xmtpInstallationId, deviceId, req } = args;

  try {
    req.log.info(
      `Cleaning up installation: ${xmtpInstallationId} for device: ${deviceId}`,
    );
    await prisma.$transaction([
      prisma.identitiesOnDevice.updateMany({
        where: { xmtpInstallationId: xmtpInstallationId },
        data: { xmtpInstallationId: null },
      }),
      prisma.device.update({
        where: { id: deviceId },
        data: {
          pushToken: null,
          pushFailures: { increment: 1 },
        },
      }),
    ]);
    req.log.info(
      `Successfully cleaned xmtpInstallationId ${xmtpInstallationId} and tokens for device ${deviceId} from local DB.`,
    );

    await notificationClient.deleteInstallation({
      installationId: xmtpInstallationId,
    });
    req.log.info(
      `Successfully requested deletion of xmtpInstallationId ${xmtpInstallationId} from XMTP server.`,
    );
  } catch (cleanupError) {
    req.log.error(
      { error: cleanupError, xmtpInstallationId, deviceId },
      "Failed during cleanup of installation",
    );
  }
}
