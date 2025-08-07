import http2 from "node:http2";
import type { Device } from "@prisma/client";
import type { Request } from "express";
import jwt from "jsonwebtoken";
import type { NotificationResponse } from "@/notifications/client";
import type { PushMessageData } from "./push-notification.service";

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
    messageData: PushMessageData;
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

    return new Promise((resolve) => {
      const hostname =
        device.apnsEnv === "sandbox"
          ? "api.sandbox.push.apple.com"
          : "api.push.apple.com";

      const client = http2.connect(`https://${hostname}`, {
        settings: { enablePush: false },
      });

      client.on("error", (error: Error) => {
        req.log.error(
          { error: error.message, stack: error.stack, deviceId: device.id },
          "HTTP/2 connection error",
        );
        client.close();
        resolve({ success: false, error: error.message });
      });

      const headers = {
        ":method": "POST",
        ":path": `/3/device/${device.pushToken}`,
        authorization: `bearer ${token}`,
        "apns-topic": this.config.bundleId,
        "apns-push-type": notification.subscription.is_silent
          ? "background"
          : "alert",
        "apns-priority": notification.subscription.is_silent ? "5" : "10",
        "content-type": "application/json",
      };

      req.log.info(
        {
          url: `https://${hostname}/3/device/${device.pushToken}`,
          headers,
          payload,
          deviceId: device.id,
          verbose: true,
        },
        "[VERBOSE] Sending APNS HTTP/2 request",
      );

      const request = client.request(headers);

      let responseData = "";
      let statusCode = 0;
      let responseHeaders: Record<string, string | number> = {};

      request.on("response", (headers: Record<string, string | number>) => {
        statusCode = headers[":status"] as number;
        responseHeaders = headers;
        req.log.info(
          {
            status: statusCode,
            headers: responseHeaders,
            deviceId: device.id,
            verbose: true,
          },
          "[VERBOSE] APNS HTTP/2 response received",
        );
      });

      request.on("data", (chunk: Buffer) => {
        const chunkStr = chunk.toString("utf8");
        responseData += chunkStr;
        req.log.info(
          { chunk: chunkStr, deviceId: device.id, verbose: true },
          "[VERBOSE] APNS response data chunk",
        );
      });

      request.on("end", () => {
        client.close();

        if (statusCode === 200) {
          req.log.info(
            {
              deviceId: device.id,
              apnsEnv: device.apnsEnv,
              apnsId: responseHeaders["apns-id"] as string,
              verbose: true,
            },
            "[VERBOSE] APNS push notification sent successfully",
          );
          resolve({ success: true });
          return;
        }

        // Handle error response
        let errorData: { reason?: string } = { reason: "Unknown error" };
        try {
          if (responseData) {
            errorData = JSON.parse(responseData) as { reason?: string };
          }
        } catch {
          // Ignore JSON parse errors
        }

        req.log.error(
          {
            status: statusCode,
            error: errorData,
            responseData,
            deviceId: device.id,
            apnsEnv: device.apnsEnv,
            verbose: true,
          },
          "[VERBOSE] APNS push notification failed",
        );

        // Handle specific APNS errors
        if (
          statusCode === 410 ||
          errorData.reason === "BadDeviceToken" ||
          errorData.reason === "Unregistered"
        ) {
          resolve({ success: false, error: "BadDeviceToken" });
          return;
        }

        resolve({
          success: false,
          error: errorData.reason || `HTTP ${statusCode}`,
        });
      });

      request.on("error", (error: Error) => {
        req.log.error(
          {
            error: error.message,
            stack: error.stack,
            deviceId: device.id,
            verbose: true,
          },
          "[VERBOSE] APNS HTTP/2 request error",
        );
        client.close();
        resolve({ success: false, error: error.message });
      });

      // Send the payload
      const payloadStr = JSON.stringify(payload);
      req.log.info(
        {
          payloadLength: payloadStr.length,
          deviceId: device.id,
          verbose: true,
        },
        "[VERBOSE] Writing APNS payload to HTTP/2 stream",
      );

      request.write(payloadStr);
      request.end();

      req.log.info(
        { deviceId: device.id, verbose: true },
        "[VERBOSE] APNS HTTP/2 request stream ended",
      );
    });
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

  // Convert \n escape sequences to actual newlines
  const formattedPrivateKey = privateKey.replace(/\\n/g, "\n");

  return new ApnsPushService({
    teamId,
    keyId,
    privateKey: formattedPrivateKey,
    bundleId,
  });
}
