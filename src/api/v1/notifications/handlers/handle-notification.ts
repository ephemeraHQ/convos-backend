import { PrismaClient } from "@prisma/client";
import { Expo, type ExpoPushMessage } from "expo-server-sdk";
import type { Request, Response } from "express";

const prisma = new PrismaClient();
const expo = new Expo();

export type ReceivedNotification = {
  idempotency_key: string;
  message: {
    content_topic: string;
    timestamp_ns: number;
    message: string;
  };
  message_context: {
    message_type: string;
    should_push: boolean;
  };
  installation: {
    id: string;
    delivery_mechanism: {
      kind: "apns" | "fcm";
      token: string;
    };
  };
  subscription: {
    created_at: string;
    topic: string;
    is_silent: boolean;
  };
};

export async function handleNotification(req: Request, res: Response) {
  try {
    const notification = req.body as ReceivedNotification;

    // Log the notification for debugging
    console.log(
      "Received notification:",
      JSON.stringify(notification, null, 2),
    );

    // Check if this notification should trigger a push
    if (!notification.message_context.should_push) {
      res.status(200).end();
      return;
    }

    const device = await prisma.device.findFirst({
      where: {
        pushToken: notification.installation.delivery_mechanism.token,
      },
    });

    if (!device) {
      console.error(
        `Device with push token ${notification.installation.delivery_mechanism.token} not found`,
      );
      res.status(404).end();
      return;
    }

    const expoPushToken = device.expoToken;

    // Validate the Expo push token
    if (!Expo.isExpoPushToken(expoPushToken)) {
      console.error(
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
        };

    // Send the notification
    const chunks = expo.chunkPushNotifications([message]);
    const sendPromises = chunks.map(async (chunk) => {
      try {
        const ticketChunk = await expo.sendPushNotificationsAsync(chunk);
        console.log("Push notification sent:", ticketChunk);
        return ticketChunk;
      } catch (error) {
        console.error("Error sending push notification:", error);
        throw error;
      }
    });

    await Promise.all(sendPromises);

    // Respond with success
    res.status(200).end();
  } catch (error) {
    console.error("Error processing notification:", error);
    res.status(500).end();
  }
}
