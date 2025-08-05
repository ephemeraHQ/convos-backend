import type { Device } from "@prisma/client";
import { Expo, type ExpoPushMessage } from "expo-server-sdk";
import type { Request } from "express";
import type { NotificationResponse } from "@/notifications/client";

const expo = new Expo();

export interface PushMessageData extends Record<string, unknown> {
  contentTopic: string;
  messageType: string;
  encryptedMessage: string;
  timestamp: string;
  ethAddress?: string;
}

export async function sendExpoPushNotification(args: {
  device: Device;
  notification: NotificationResponse;
  messageData: PushMessageData;
  req: Request;
}): Promise<{ success: boolean; error?: string }> {
  const { device, notification, messageData, req } = args;

  // Use expoToken (legacy) or pushToken (old way) for Expo notifications
  const expoPushToken = device.expoToken || device.pushToken;

  if (!expoPushToken) {
    return { success: false, error: "No Expo push token available" };
  }

  if (!Expo.isExpoPushToken(expoPushToken)) {
    return { success: false, error: "Invalid Expo push token format" };
  }

  const message: ExpoPushMessage = notification.subscription.is_silent
    ? {
        to: expoPushToken,
        data: messageData,
        _contentAvailable: true,
        priority: "normal",
        sound: undefined,
      }
    : {
        to: expoPushToken,
        sound: "default",
        body: "New message",
        data: messageData,
        priority: "high",
        mutableContent: true,
      };

  const chunks = expo.chunkPushNotifications([message]);

  try {
    for (const chunk of chunks) {
      const tickets = await expo.sendPushNotificationsAsync(chunk);

      for (const ticket of tickets) {
        if (ticket.status === "error") {
          req.log.error(
            {
              details: ticket.details,
              xmtpInstallationId: notification.installation.id,
            },
            `Error sending Expo push notification: ${ticket.message}`,
          );

          if (
            ticket.details &&
            ticket.details.error === "DeviceNotRegistered"
          ) {
            return {
              success: false,
              error: "DeviceNotRegistered",
            };
          }

          return {
            success: false,
            error: ticket.message || "Unknown error",
          };
        }
      }
    }

    return { success: true };
  } catch (error) {
    req.log.error(
      { error, xmtpInstallationId: notification.installation.id },
      "Critical error sending Expo push notifications",
    );
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

export async function sendLegacyExpoPushNotification(args: {
  notification: NotificationResponse;
  ethAddress: string;
  expoPushToken: string;
  req: Request;
}): Promise<void> {
  const { notification, ethAddress, expoPushToken, req } = args;

  const baseMessageData: PushMessageData = {
    contentTopic: notification.message.content_topic,
    messageType: notification.message_context.message_type,
    encryptedMessage: notification.message.message,
    timestamp: notification.message.timestamp_ns,
    ethAddress: ethAddress,
  };

  const message: ExpoPushMessage = notification.subscription.is_silent
    ? {
        to: expoPushToken,
        data: baseMessageData,
        _contentAvailable: true,
        priority: "normal",
        sound: undefined,
      }
    : {
        to: expoPushToken,
        sound: "default",
        body: "New message",
        data: baseMessageData,
        priority: "high",
        mutableContent: true,
      };

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
}
