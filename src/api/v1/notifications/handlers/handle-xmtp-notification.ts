import { Expo, type ExpoPushMessage } from "expo-server-sdk";
import type { Request, Response } from "express";
import type { NotificationResponse } from "@/notifications/client";
import { getHttpDeliveryNotificationAuthHeader } from "@/notifications/utils";
import { prisma } from "@/utils/prisma";

const expo = new Expo();

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
  try {
    const notification = req.body as NotificationResponse;

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

    const device = await prisma.device.findFirst({
      where: {
        pushToken: notification.installation.delivery_mechanism.token,
      },
      include: {
        identities: {
          include: {
            identity: true,
          },
        },
      },
    });

    if (!device) {
      req.log.error(
        `Device with push token ${notification.installation.delivery_mechanism.token} not found`,
      );
      res.status(404).end();
      return;
    }

    const expoPushToken = device.expoToken;
    const turnkeyAddress =
      device.identities.length > 0
        ? device.identities[0].identity.turnkeyAddress
        : undefined;

    if (!turnkeyAddress) {
      req.log.error(
        `Device with push token ${notification.installation.delivery_mechanism.token} has no identity`,
      );
      res.status(200).end();
      return;
    }

    // Validate the Expo push token
    if (!Expo.isExpoPushToken(expoPushToken)) {
      req.log.error(
        `Push token ${expoPushToken} is not a valid Expo push token`,
      );
      res.status(200).end();
      return;
    }

    // Prepare the base message data that's common for both silent and regular notifications
    const baseMessageData = {
      contentTopic: notification.message.content_topic,
      messageType: notification.message_context.message_type,
      encryptedMessage: notification.message.message,
      timestamp: notification.message.timestamp_ns,
      ethAddress: turnkeyAddress,
    };

    // Create the message based on whether it's silent or regular
    const message: ExpoPushMessage = notification.subscription.is_silent
      ? {
          // Silent notification configuration
          to: expoPushToken,
          data: baseMessageData,
          // Required for iOS silent notifications
          _contentAvailable: true,
          // Required for Android silent notifications
          priority: "normal",
          // Ensure no visible alerts
          sound: undefined,
        }
      : {
          // Regular notification configuration
          to: expoPushToken,
          sound: "default",
          body: "New message",
          data: baseMessageData,
          priority: "high",
          mutableContent: true,
        };

    // Send the notification
    const chunks = expo.chunkPushNotifications([message]);
    const sendPromises = chunks.map(async (chunk) => {
      try {
        const ticketChunk = await expo.sendPushNotificationsAsync(chunk);
        req.log.info({ ticketChunk }, "push notification sent");
        return ticketChunk;
      } catch (error) {
        req.log.error({ error }, "Error sending push notification:");
        throw error;
      }
    });

    await Promise.all(sendPromises);

    // Respond with success
    res.status(200).end();
  } catch (error) {
    console.error("Error processing notification:", error);
    res.status(500).json({ error: "Internal server error" });
  }
}
