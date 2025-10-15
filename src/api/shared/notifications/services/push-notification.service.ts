import type {
  Device,
  DeviceIdentity,
  IdentitiesOnDevice,
} from "@prisma/client";
import { createJwtToken } from "@/utils/jwt";
import logger from "@/utils/logger";
import { prisma } from "@/utils/prisma";
import { createApnsService, type ApnsPushService } from "./apns-push.service";
import type {
  NotificationPayload,
  NotificationPayloadWithJWTToken,
} from "./notifications-types";

type IdentityOnDeviceWithRelations = IdentitiesOnDevice & {
  device: Device;
  identity: DeviceIdentity;
};

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
      include: {
        identities: {
          include: {
            identity: true,
          },
        },
      },
    });
    if (!device) {
      return { success: false, shouldCleanup: false };
    }
    // Find the identity that matches the notification's inboxId to get the xmtpInstallationId
    const targetIdentityOnDevice = device.identities.find(
      (identityOnDevice) =>
        identityOnDevice.identity.xmtpId === notification.inboxId,
    );

    if (!targetIdentityOnDevice) {
      logger.error(
        { deviceId: device.id, inboxId: notification.inboxId },
        "No matching identity found on device for notification",
      );
      return { success: false };
    }

    if (!targetIdentityOnDevice.xmtpInstallationId) {
      logger.error(
        { deviceId: device.id, inboxId: notification.inboxId },
        "No XMTP installation ID found for identity",
      );
      return { success: false };
    }

    // Create the IdentityOnDeviceWithRelations object
    const identityOnDevice: IdentityOnDeviceWithRelations = {
      ...targetIdentityOnDevice,
      device,
    };

    return this.sendPushNotification({
      identityOnDevice,
      notification,
    });
  }

  async _sendPushNotification(args: {
    identityOnDevice: IdentityOnDeviceWithRelations;
    notification: NotificationPayload;
  }): Promise<SendNotificationResult> {
    const { identityOnDevice, notification } = args;
    const device = identityOnDevice.device;

    if (!identityOnDevice.xmtpInstallationId) {
      logger.error(
        { deviceId: device.id, identityId: identityOnDevice.identityId },
        "No XMTP installation ID found for identity on device",
      );
      return { success: false };
    }

    const xmtpInstallationId = identityOnDevice.xmtpInstallationId;

    // V1 notifications always have inboxId
    if (!notification.inboxId) {
      logger.error(
        { deviceId: device.id },
        "Missing inboxId for v1 notification",
      );
      return { success: false };
    }

    // We add an JWT token to the notification payload to be used by the client
    // So the notification extension is able to communicate with our backend (App Attest not supported in extensions so we can't call authenticate)
    const apiJWT = await createJwtToken({
      inboxId: notification.inboxId,
      xmtpInstallationId,
      expirationTime: "72h",
      metadata: {
        notificationExtensionOnly: true,
      },
    });

    const notificationWithJWTToken = {
      ...notification,
      apiJWT,
    } as NotificationPayloadWithJWTToken;

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
          notification: notificationWithJWTToken,
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

  async sendPushNotification(args: {
    identityOnDevice: IdentityOnDeviceWithRelations;
    notification: NotificationPayload;
  }): Promise<SendNotificationResult> {
    try {
      const notificationResult = await this._sendPushNotification(args);
      return notificationResult;
    } catch (error) {
      logger.error(
        { error, deviceId: args.identityOnDevice.device.id },
        "Unexpected error sending push",
      );
      await this.incrementPushFailures(args.identityOnDevice.device.id);
      return { success: false };
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
