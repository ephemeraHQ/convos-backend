#!/usr/bin/env bun
import type { Request } from "express";
import { createApnsService } from "@/api/v1/notifications/services/apns-push.service";
import type { WebhookNotificationBody } from "@/notifications/client";
import { prisma } from "@/utils/prisma";

// Mock logger to replace req.log
const mockLogger = {
  info: (data: unknown, message?: string) => {
    console.log(`[INFO] ${message || ""}`, data);
  },
  error: (data: unknown, message?: string) => {
    console.error(`[ERROR] ${message || ""}`, data);
  },
  warn: (data: unknown, message?: string) => {
    console.warn(`[WARN] ${message || ""}`, data);
  },
};

// Mock request object for the APNS service
const mockRequest = {
  log: mockLogger,
} as Request;

interface TestPushArgs {
  userId: string;
  title?: string;
  body?: string;
  isSilent?: boolean;
  forceApnsEnv?: "sandbox" | "production" | null;
}

async function sendTestPushNotification(args: TestPushArgs) {
  const {
    userId,
    title: _title = "Test Notification",
    body: _body = "This is a test push notification",
    isSilent = false,
    forceApnsEnv = null,
  } = args;

  console.log(`🔍 Looking for devices for user: ${userId}`);

  // Find all APNS devices for the given user
  const user = await prisma.user.findFirst({
    where: {
      userId,
      devices: {
        some: {
          device: {
            pushTokenType: "apns",
            pushToken: { not: null },
          },
        },
      },
    },
    include: {
      devices: {
        include: {
          device: true,
        },
      },
    },
  });

  const devices = user?.devices.map((device) => device.device);

  if (!devices || devices.length === 0) {
    console.log(`❌ No APNS devices found for user ${userId}`);
    return;
  }

  console.log(`📱 Found ${devices.length} APNS device(s) for user ${userId}`);

  // Create APNS service
  const apnsService = createApnsService();
  if (!apnsService) {
    console.error(
      "❌ APNS service not configured. Please check your environment variables:",
    );
    console.error("- APNS_TEAM_ID");
    console.error("- APNS_KEY_ID");
    console.error("- APNS_PRIVATE_KEY");
    console.error("- APNS_BUNDLE_ID");
    return;
  }

  // Create mock notification response
  const mockNotification: WebhookNotificationBody = {
    subscription: {
      is_silent: isSilent,
    },
    message: {
      content_topic: "test-topic",
      message: "encrypted-test-message-data",
      timestamp_ns: Date.now().toString() + "000000", // Convert to nanoseconds
    },
    message_context: {
      message_type: "test",
    },
  } as WebhookNotificationBody;

  // Create mock message data
  const messageData = {
    contentTopic: "test-topic",
    messageType: "test",
    encryptedMessage: "encrypted-test-message-data",
    timestamp: Date.now().toString() + "000000",
    inboxId: "1234567890123456789012345678901234567890", // Mock inbox id
  };

  // Send push notification to each device
  for (const device of devices) {
    // Override APNS environment if specified
    const effectiveDevice = forceApnsEnv
      ? { ...device, apnsEnv: forceApnsEnv }
      : device;

    console.log(`\n📤 Sending test push notification to device:`);
    console.log(`   - Device ID: ${device.id}`);
    console.log(`   - Device Name: ${device.name || "Unnamed"}`);
    console.log(`   - OS: ${device.os}`);
    console.log(
      `   - APNS Environment: ${effectiveDevice.apnsEnv || "production"}${forceApnsEnv ? " (forced)" : ""}`,
    );
    console.log(`   - Push Token: ${device.pushToken?.substring(0, 20)}...`);
    console.log(`   - Silent: ${isSilent}`);

    try {
      const result = await apnsService.sendPushNotification({
        device: effectiveDevice,
        notification: mockNotification,
        messageData,
        req: mockRequest,
      });

      if (result.success) {
        console.log(
          `✅ Successfully sent push notification to device ${device.id}`,
        );
      } else {
        console.log(
          `❌ Failed to send push notification to device ${device.id}: ${result.error}`,
        );
      }
    } catch (error) {
      console.error(
        `💥 Error sending push notification to device ${device.id}:`,
        error,
      );
    }
  }
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.log(`
🚀 Test Push Notification CLI

Usage: bun run scripts/test-push-notification.ts <userId> [options]

Arguments:
  userId                   The user ID to send test push notifications to

Options:
  --title <title>         Custom notification title (default: "Test Notification")
  --body <body>          Custom notification body (default: "This is a test push notification")
  --silent               Send as silent/background notification (default: false)
  --sandbox              Force sandbox/development APNS environment
  --production           Force production APNS environment
  --help, -h             Show this help message

Examples:
  bun run scripts/test-push-notification.ts user-123
  bun run scripts/test-push-notification.ts user-123 --title "Hello" --body "Custom message"
  bun run scripts/test-push-notification.ts user-123 --silent

Environment Variables Required:
  APNS_TEAM_ID           Your Apple Developer Team ID
  APNS_KEY_ID            Your APNS Auth Key ID
  APNS_PRIVATE_KEY       Your APNS Auth Key (PEM format)
  APNS_BUNDLE_ID         Your app's bundle identifier
  DATABASE_URL           Database connection string
`);
    process.exit(0);
  }

  const userId = args[0];
  let title = "Test Notification";
  let body = "This is a test push notification";
  let isSilent = false;
  let forceApnsEnv: "sandbox" | "production" | null = null;

  // Parse additional arguments
  for (let i = 1; i < args.length; i++) {
    switch (args[i]) {
      case "--title":
        if (i + 1 >= args.length) {
          console.error("❌ Error: --title requires a value");
          process.exit(1);
        }
        title = args[++i];
        if (!title.trim()) {
          console.error("❌ Error: --title value cannot be empty");
          process.exit(1);
        }
        break;
      case "--body":
        if (i + 1 >= args.length) {
          console.error("❌ Error: --body requires a value");
          process.exit(1);
        }
        body = args[++i];
        if (!body.trim()) {
          console.error("❌ Error: --body value cannot be empty");
          process.exit(1);
        }
        break;
      case "--silent":
        isSilent = true;
        break;
      case "--sandbox":
        forceApnsEnv = "sandbox";
        break;
      case "--production":
        forceApnsEnv = "production";
        break;
    }
  }

  if (!userId) {
    console.error("❌ User ID is required");
    process.exit(1);
  }

  console.log("🚀 Starting test push notification...\n");

  try {
    await sendTestPushNotification({
      userId,
      title,
      body,
      isSilent,
      forceApnsEnv,
    });
  } catch (error) {
    console.error("💥 Fatal error:", error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
    console.log("\n✨ Done!");
  }
}

// Run if this file is executed directly
if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error("💥 Unhandled error:", error);
    process.exit(1);
  });
}
