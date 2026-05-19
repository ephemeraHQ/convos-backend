import http2 from "node:http2";
import type { ApnsEnvironment, PushTokenType } from "@prisma/client";
import jwt from "jsonwebtoken";
import logger from "@/utils/logger";
import type {
  AnyNotificationPayloadWithJWT,
  NotificationPayload,
} from "./types";

// Device-like interface for APNS service (compatible with DeviceRegistration)
export interface ApnsDevice {
  id: string;
  pushToken: string | null;
  pushTokenType: PushTokenType;
  apnsEnv: ApnsEnvironment | null;
}

export interface ApnsConfig {
  teamId: string;
  keyId: string;
  privateKey: string;
  bundleId: string;
}

export type ApnsNotificationPayload = NotificationPayload & {
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
};

/** Mask a token for safe logging: show first 8 and last 4 chars */
function maskToken(token: string): string {
  if (token.length <= 16) return `${token.slice(0, 4)}...${token.slice(-4)}`;
  return `${token.slice(0, 8)}...${token.slice(-4)} (len=${token.length})`;
}

/**
 * Build the APNS wire payload (the JSON body sent in the POST request).
 * This is the exact object measured against the 4096-byte APNS payload limit.
 * Exported so the handler can size-check before dispatch using identical shape.
 */
export function buildApnsWirePayload(args: {
  notification: AnyNotificationPayloadWithJWT;
  isSilent: boolean;
}): ApnsNotificationPayload {
  const { notification, isSilent } = args;
  return isSilent
    ? {
        aps: {
          "content-available": 1,
        },
        ...notification,
      }
    : {
        aps: {
          alert: {
            body: "New message",
          },
          sound: "default",
          "mutable-content": 1,
        },
        ...notification,
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

  private getApnsUrl(device: ApnsDevice): string {
    const hostname =
      device.apnsEnv === "sandbox"
        ? "api.sandbox.push.apple.com"
        : "api.push.apple.com";
    return `https://${hostname}/3/device/${device.pushToken}`;
  }

  async sendPushNotification(args: {
    device: ApnsDevice;
    notification: AnyNotificationPayloadWithJWT;
    isSilent?: boolean;
  }): Promise<{ success: boolean; error?: string }> {
    const { device, notification, isSilent } = args;

    if (!device.pushToken) {
      logger.warn(
        { deviceId: device.id },
        "[APNS] No push token available – skipping send",
      );
      return { success: false, error: "No APNS push token available" };
    }

    if (device.pushTokenType !== "apns") {
      logger.warn(
        { deviceId: device.id, pushTokenType: device.pushTokenType },
        "[APNS] Device push token type mismatch – expected 'apns'",
      );
      return { success: false, error: "Device is not configured for APNS" };
    }

    // Narrowed after the null guard above
    const pushToken = device.pushToken;

    const payload = buildApnsWirePayload({
      notification,
      isSilent: !!isSilent,
    });

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
        logger.error(
          { error: error.message, stack: error.stack, deviceId: device.id },
          "[APNS] HTTP/2 connection error",
        );
        client.close();
        resolve({ success: false, error: error.message });
      });

      const headers = {
        ":method": "POST",
        ":path": `/3/device/${device.pushToken}`,
        authorization: `bearer ${token}`,
        "apns-topic": this.config.bundleId,
        "apns-push-type": isSilent ? "background" : "alert",
        "apns-priority": isSilent ? "5" : "10",
        "content-type": "application/json",
      };

      // Extract content topic for logging (if Protocol notification)
      const contentTopic =
        "contentTopic" in notification.notificationData
          ? (notification.notificationData as { contentTopic?: string })
              .contentTopic
          : undefined;

      const safeHeaders = { ...headers, authorization: "[REDACTED]" };
      logger.info(
        {
          url: `https://${hostname}/3/device/${maskToken(pushToken)}`,
          pushTokenMasked: maskToken(pushToken),
          headers: safeHeaders,
          deviceId: device.id,
          apnsEnv: device.apnsEnv,
          isSilent,
          notificationType: notification.notificationType,
          contentTopic,
          bundleId: this.config.bundleId,
          payloadSize: Buffer.byteLength(JSON.stringify(payload), "utf8"),
          verbose: true,
        },
        "[APNS] Sending HTTP/2 push request",
      );

      const request = client.request(headers);

      let responseData = "";
      let statusCode = 0;
      let responseHeaders: Record<string, string | number> = {};

      request.on("response", (headers: Record<string, string | number>) => {
        statusCode = headers[":status"] as number;
        responseHeaders = headers;
        logger.info(
          {
            status: statusCode,
            headers: responseHeaders,
            deviceId: device.id,
            verbose: true,
          },
          "[APNS] HTTP/2 response received",
        );
      });

      request.on("data", (chunk: Buffer) => {
        const chunkStr = chunk.toString("utf8");
        responseData += chunkStr;
        logger.info(
          { chunk: chunkStr, deviceId: device.id, verbose: true },
          "[APNS] Response data chunk",
        );
      });

      request.on("end", () => {
        client.close();

        if (statusCode === 200) {
          logger.info(
            {
              deviceId: device.id,
              apnsEnv: device.apnsEnv,
              pushTokenMasked: maskToken(pushToken),
              apnsId: responseHeaders["apns-id"] as string,
              bundleId: this.config.bundleId,
            },
            "[APNS] Push notification sent successfully",
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

        logger.error(
          {
            status: statusCode,
            error: errorData,
            responseData,
            deviceId: device.id,
            apnsEnv: device.apnsEnv,
            pushTokenMasked: maskToken(pushToken),
            bundleId: this.config.bundleId,
          },
          "[APNS] Push notification failed",
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

        if (statusCode === 413 || errorData.reason === "PayloadTooLarge") {
          resolve({ success: false, error: "PayloadTooLarge" });
          return;
        }

        resolve({
          success: false,
          error: errorData.reason || `HTTP ${statusCode}`,
        });
      });

      request.on("error", (error: Error) => {
        logger.error(
          {
            error: error.message,
            stack: error.stack,
            deviceId: device.id,
            pushTokenMasked: maskToken(pushToken),
          },
          "[APNS] HTTP/2 request error",
        );
        client.close();
        resolve({ success: false, error: error.message });
      });

      // Send the payload
      const payloadStr = JSON.stringify(payload);
      logger.info(
        {
          payloadLength: payloadStr.length,
          deviceId: device.id,
          verbose: true,
        },
        "[APNS] Writing payload to HTTP/2 stream",
      );

      request.write(payloadStr);
      request.end();
    });
  }
}

// Cached APNS service instance
let cachedApnsService: ApnsPushService | null = null;
let apnsServiceInitialized = false;

// Factory function to create or return cached APNS service
export function createApnsService(): ApnsPushService | null {
  if (apnsServiceInitialized) {
    return cachedApnsService;
  }

  apnsServiceInitialized = true;

  const teamId = process.env.APNS_TEAM_ID;
  const keyId = process.env.APNS_KEY_ID;
  const privateKey = process.env.APNS_PRIVATE_KEY;
  const bundleId = process.env.APNS_BUNDLE_ID;

  if (!teamId || !keyId || !privateKey || !bundleId) {
    logger.warn(
      "[APNS] Configuration incomplete, APNS push notifications disabled",
    );
    return null;
  }

  // Convert \n escape sequences to actual newlines
  const formattedPrivateKey = privateKey.replace(/\\n/g, "\n");

  logger.info({ teamId, keyId, bundleId }, "[APNS] Initialising APNS service");

  cachedApnsService = new ApnsPushService({
    teamId,
    keyId,
    privateKey: formattedPrivateKey,
    bundleId,
  });

  return cachedApnsService;
}
