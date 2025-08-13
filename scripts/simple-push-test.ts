#!/usr/bin/env bun
import { createApnsService } from "@/api/v1/notifications/services/apns-push.service";
import { prisma } from "@/utils/prisma";

// Simple version - just provide a userId and it will send a basic test notification
async function quickPushTest(userId: string) {
  console.log(`🔥 Quick Push Test for user: ${userId}\n`);

  // Find any APNS device for this user
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
          device: {
            include: {
              identities: {
                include: {
                  identity: true,
                },
              },
            },
          },
        },
      },
    },
  });

  if (!user) {
    console.log("❌ No APNS device found for this user");
    return;
  }

  const firstDevice = user.devices[0].device;

  console.log(
    `📱 Found device: ${firstDevice.id || "Unnamed"} (${firstDevice.os})`,
  );

  const apnsService = createApnsService();
  if (!apnsService) {
    console.log("❌ APNS not configured");
    return;
  }

  const messageData = {
    contentTopic: "test-topic",
    messageType: "test",
    encryptedMessage: "Hello from the backend! 👋",
    timestamp: Date.now().toString() + "000000",
  };

  console.log("📤 Sending notification...");

  const result = await apnsService.sendPushNotification({
    device: firstDevice,
    notification: {
      inboxId: firstDevice.identities[0].identity.xmtpId,
      notificationType: "Protocol",
      notificationData: messageData,
    },
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
