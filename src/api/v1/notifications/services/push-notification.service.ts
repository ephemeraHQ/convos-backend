import type { Device } from "@prisma/client";
import type { Request } from "express";
import type { NotificationResponse } from "@/notifications/client";
import { prisma } from "@/utils/prisma";
import { createApnsService, type ApnsPushService } from "./apns-push.service";
import {
  sendExpoPushNotification,
  type PushMessageData,
} from "./expo-push.service";

export class PushNotificationService {
  private apnsService: ApnsPushService | null;

  constructor() {
    this.apnsService = createApnsService();
  }

  async sendPushNotification(args: {
    device: Device;
    notification: NotificationResponse;
    turnkeyAddress: string | null;
    req: Request;
  }): Promise<{ success: boolean; shouldCleanup?: boolean }> {
    const { device, notification, turnkeyAddress, req } = args;

    // Check if device has too many push failures
    if (device.pushFailures > 10) {
      req.log.warn(
        `Device ${device.id} has too many push failures (${device.pushFailures}). Skipping notification.`,
      );
      return { success: false };
    }

    const messageData: PushMessageData = {
      contentTopic: notification.message.content_topic,
      messageType: notification.message_context.message_type,
      encryptedMessage: notification.message.message,
      timestamp: notification.message.timestamp_ns,
      ...(turnkeyAddress && { ethAddress: turnkeyAddress }),
    };

    // Determine which push service to use
    const pushTokenType: string = device.pushTokenType ?? "expo";

    let result: { success: boolean; error?: string };

    switch (pushTokenType) {
      case "expo":
        result = await sendExpoPushNotification({
          device,
          notification,
          messageData,
          req,
        });
        break;

      case "apns":
        if (!this.apnsService) {
          req.log.error("APNS service not configured");
          return { success: false };
        }
        result = await this.apnsService.sendPushNotification({
          device,
          notification,
          messageData,
          req,
        });
        break;

      case "fcm":
        req.log.warn(
          `FCM push notifications not yet implemented for device ${device.id}`,
        );
        return { success: false };

      default:
        req.log.warn(`No valid push token type for device ${device.id}`);
        return { success: false };
    }

    // Handle the result
    if (result.success) {
      await this.updateLastPushSuccess(device.id, req);
      return { success: true };
    } else {
      await this.incrementPushFailures(device.id, req);

      // Check if we should cleanup the device
      const shouldCleanup =
        result.error === "DeviceNotRegistered" ||
        result.error === "BadDeviceToken";

      return { success: false, shouldCleanup };
    }
  }

  private async incrementPushFailures(deviceId: string, req: Request) {
    try {
      await prisma.device.update({
        where: { id: deviceId },
        data: { pushFailures: { increment: 1 } },
      });
      req.log.info(`Incremented push failures for device ${deviceId}`);
    } catch (error) {
      req.log.error({ error, deviceId }, "Failed to increment push failures");
    }
  }

  private async updateLastPushSuccess(deviceId: string, req: Request) {
    try {
      await prisma.device.update({
        where: { id: deviceId },
        data: {
          lastPushSuccessAt: new Date(),
          pushFailures: 0, // Reset failures on successful push
        },
      });
      req.log.info(`Updated last push success for device ${deviceId}`);
    } catch (error) {
      req.log.error({ error, deviceId }, "Failed to update last push success");
    }
  }
}

// Singleton instance
let pushNotificationService: PushNotificationService | null = null;

export function getPushNotificationService(): PushNotificationService {
  if (!pushNotificationService) {
    pushNotificationService = new PushNotificationService();
  }
  return pushNotificationService;
}
