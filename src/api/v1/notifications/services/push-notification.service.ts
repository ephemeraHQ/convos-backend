import type { Device } from "@prisma/client";
import logger from "@/utils/logger";
import { prisma } from "@/utils/prisma";
import { createApnsService, type ApnsPushService } from "./apns-push.service";
import type { NotificationPayload } from "./notifications-types";

type SendNotificationResult = {
  success: boolean;
  shouldCleanup?: boolean;
};

export class PushNotificationService {
  private apnsService: ApnsPushService | null;

  constructor() {
    this.apnsService = createApnsService();
  }

  async sendPushNotificationToXmtpId(args: {
    xmtpId: string;
    notification: NotificationPayload;
  }): Promise<SendNotificationResult> {
    const { xmtpId, notification } = args;
    // Right now one xmtp id = one device, we can adapt in the future
    const device = await prisma.device.findFirst({
      where: {
        identities: {
          some: {
            identity: { xmtpId: xmtpId },
          },
        },
      },
    });
    if (!device) {
      return { success: false, shouldCleanup: false };
    }
    return this.sendPushNotification({ device, notification });
  }

  async sendPushNotification(args: {
    device: Device;
    notification: NotificationPayload;
  }): Promise<SendNotificationResult> {
    const { device, notification } = args;

    // Check if device has too many push failures
    if (device.pushFailures > 10) {
      logger.warn(
        `Device ${device.id} has too many push failures (${device.pushFailures}). Skipping notification.`,
      );
      return { success: false };
    }

    // Determine which push service to use
    const pushTokenType = device.pushTokenType;

    let result: { success: boolean; error?: string };

    switch (pushTokenType) {
      case "apns":
        if (!this.apnsService) {
          logger.error("APNS service not configured");
          return { success: false };
        }
        result = await this.apnsService.sendPushNotification({
          device,
          notification,
        });
        break;

      case "fcm":
        logger.warn(
          `FCM push notifications not yet implemented for device ${device.id}`,
        );
        return { success: false };

      default:
        logger.warn(`No valid push token type for device ${device.id}`);
        return { success: false };
    }

    // Handle the result
    if (result.success) {
      await this.updateLastPushSuccess(device.id);
      return { success: true };
    } else {
      await this.incrementPushFailures(device.id);

      // Check if we should cleanup the device
      const shouldCleanup =
        result.error === "DeviceNotRegistered" ||
        result.error === "BadDeviceToken";

      return { success: false, shouldCleanup };
    }
  }

  private async incrementPushFailures(deviceId: string) {
    try {
      await prisma.device.update({
        where: { id: deviceId },
        data: { pushFailures: { increment: 1 } },
      });
      logger.info(`Incremented push failures for device ${deviceId}`);
    } catch (error) {
      logger.error({ error, deviceId }, "Failed to increment push failures");
    }
  }

  private async updateLastPushSuccess(deviceId: string) {
    try {
      await prisma.device.update({
        where: { id: deviceId },
        data: {
          lastPushSuccessAt: new Date(),
          pushFailures: 0, // Reset failures on successful push
        },
      });
      logger.info(`Updated last push success for device ${deviceId}`);
    } catch (error) {
      logger.error({ error, deviceId }, "Failed to update last push success");
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
