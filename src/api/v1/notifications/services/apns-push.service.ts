import type { Device } from "@prisma/client";
import type { Request } from "express";
import jwt from "jsonwebtoken";
import type { NotificationResponse } from "@/notifications/client";

export interface ApnsConfig {
  teamId: string;
  keyId: string;
  privateKey: string;
  bundleId: string;
}

export interface ApnsNotificationPayload {
  aps: {
    alert?: {
      title?: string;
      body?: string;
    };
    badge?: number;
    sound?: string;
    "content-available"?: number;
    "mutable-content"?: number;
  };
  data: {
    contentTopic: string;
    messageType: string;
    encryptedMessage: string;
    timestamp: string;
    ethAddress?: string;
  };
}

export class ApnsPushService {
  private config: ApnsConfig;
  private jwtToken?: string;
  private jwtTokenExpiry?: number;

  constructor(config: ApnsConfig) {
    this.config = config;
  }

  private getJwtToken(): string {
    const now = Date.now() / 1000;

    // Reuse token if it's still valid (tokens are valid for 1 hour)
    if (
      this.jwtToken &&
      this.jwtTokenExpiry &&
      this.jwtTokenExpiry > now + 300
    ) {
      return this.jwtToken;
    }

    const payload = {
      iss: this.config.teamId,
      iat: Math.floor(now),
    };

    this.jwtToken = jwt.sign(payload, this.config.privateKey, {
      algorithm: "ES256",
      header: {
        alg: "ES256",
        kid: this.config.keyId,
      },
    });

    this.jwtTokenExpiry = now + 3600; // 1 hour
    return this.jwtToken;
  }

  private getApnsUrl(device: Device): string {
    const hostname =
      device.apnsEnv === "sandbox"
        ? "api.sandbox.push.apple.com"
        : "api.push.apple.com";
    return `https://${hostname}/3/device/${device.pushToken}`;
  }

  async sendPushNotification(args: {
    device: Device;
    notification: NotificationResponse;
    messageData: {
      contentTopic: string;
      messageType: string;
      encryptedMessage: string;
      timestamp: string;
      ethAddress?: string;
    };
    req: Request;
  }): Promise<{ success: boolean; error?: string }> {
    const { device, notification, messageData, req } = args;

    if (!device.pushToken) {
      return { success: false, error: "No APNS push token available" };
    }

    if (device.pushTokenType !== "apns") {
      return { success: false, error: "Device is not configured for APNS" };
    }

    const payload: ApnsNotificationPayload = notification.subscription.is_silent
      ? {
          aps: {
            "content-available": 1,
          },
          data: messageData,
        }
      : {
          aps: {
            alert: {
              body: "New message",
            },
            sound: "default",
            "mutable-content": 1,
          },
          data: messageData,
        };

    const token = this.getJwtToken();
    const url = this.getApnsUrl(device);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          authorization: `bearer ${token}`,
          "apns-topic": this.config.bundleId,
          "apns-push-type": notification.subscription.is_silent
            ? "background"
            : "alert",
          "apns-priority": notification.subscription.is_silent ? "5" : "10",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      if (response.ok) {
        req.log.info(
          {
            deviceId: device.id,
            apnsEnv: device.apnsEnv,
          },
          "APNS push notification sent successfully",
        );
        return { success: true };
      }

      // Handle error response
      let errorData: { reason?: string } = { reason: "Unknown error" };
      try {
        const text = await response.text();
        if (text) {
          errorData = JSON.parse(text) as { reason?: string };
        }
      } catch {
        // Ignore JSON parse errors
      }

      req.log.error(
        {
          status: response.status,
          error: errorData,
          deviceId: device.id,
          apnsEnv: device.apnsEnv,
        },
        "APNS push notification failed",
      );

      // Handle specific APNS errors
      if (
        response.status === 410 ||
        errorData.reason === "BadDeviceToken" ||
        errorData.reason === "Unregistered"
      ) {
        return { success: false, error: "BadDeviceToken" };
      }

      return {
        success: false,
        error: errorData.reason || `HTTP ${response.status}`,
      };
    } catch (error) {
      req.log.error(
        {
          error,
          deviceId: device.id,
        },
        "Network error sending APNS push notification",
      );
      return {
        success: false,
        error: error instanceof Error ? error.message : "Network error",
      };
    }
  }
}

// Factory function to create APNS service from environment variables
export function createApnsService(): ApnsPushService | null {
  const teamId = process.env.APNS_TEAM_ID;
  const keyId = process.env.APNS_KEY_ID;
  const privateKey = process.env.APNS_PRIVATE_KEY;
  const bundleId = process.env.APNS_BUNDLE_ID;

  if (!teamId || !keyId || !privateKey || !bundleId) {
    console.warn(
      "APNS configuration incomplete, APNS push notifications disabled",
    );
    return null;
  }

  return new ApnsPushService({
    teamId,
    keyId,
    privateKey,
    bundleId,
  });
}
