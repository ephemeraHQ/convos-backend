#!/usr/bin/env bun
import type { Request } from "express";
import { createApnsService } from "@/api/v1/notifications/services/apns-push.service";
import type { NotificationResponse } from "@/notifications/client";
import { prisma } from "@/utils/prisma";

// Simple version - just provide a userId and it will send a basic test notification
async function quickPushTest(userId: string) {
  console.log(`🔥 Quick Push Test for user: ${userId}\n`);

  // Find any APNS device for this user
  const device = await prisma.device.findFirst({
    where: {
      userId,
      pushTokenType: "apns",
      pushToken: { not: null },
    },
  });

  if (!device) {
    console.log("❌ No APNS device found for this user");
    return;
  }

  console.log(`📱 Found device: ${device.name || "Unnamed"} (${device.os})`);

  const apnsService = createApnsService();
  if (!apnsService) {
    console.log("❌ APNS not configured");
    return;
  }

  // Mock data
  const mockNotification: NotificationResponse = {
    subscription: { is_silent: false },
    message: {
      content_topic: "test-topic",
      message: "test-message",
      timestamp_ns: Date.now().toString() + "000000",
    },
    message_context: { message_type: "test" },
  } as NotificationResponse;

  const messageData = {
    contentTopic: "test-topic",
    messageType: "test",
    encryptedMessage: "Hello from the backend! 👋",
    timestamp: Date.now().toString() + "000000",
  };

  const mockReq = {
    log: {
      info: console.log,
      error: console.error,
      warn: console.warn,
    },
  } as Request;

  console.log("📤 Sending notification...");

  const result = await apnsService.sendPushNotification({
    device,
    notification: mockNotification,
    messageData,
    req: mockReq,
  });

  if (result.success) {
    console.log("✅ Push notification sent successfully!");
  } else {
    console.log(`❌ Failed: ${result.error}`);
  }
}

const userId = process.argv[2];
if (!userId) {
  console.log("Usage: bun run scripts/simple-push-test.ts <userId>");
  process.exit(1);
}

quickPushTest(userId)
  .then(() => prisma.$disconnect())
  .catch((error: unknown) => {
    console.error(error);
  });
