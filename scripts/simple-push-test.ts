#!/usr/bin/env bun
import { createApnsService } from "@/api/v1/notifications/services/apns-push.service";
import { prisma } from "@/utils/prisma";

// Simple version - just provide an XMTP ID and it will send a basic test notification
async function quickPushTest(xmtpId: string) {
  console.log(`🔥 Quick Push Test for identity (xmtpId): ${xmtpId}\n`);

  // Find any APNS device linked to this identity
  const firstDevice = await prisma.device.findFirst({
    where: {
      pushTokenType: "apns",
      pushToken: { not: null },
      identities: {
        some: {
          identity: {
            xmtpId,
          },
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

  if (!firstDevice) {
    console.log("❌ No APNS device found for this identity");
    return;
  }

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
      appCheckToken: "dummy-app-check-token",
    },
  });

  if (result.success) {
    console.log("✅ Push notification sent successfully!");
  } else {
    console.log(`❌ Failed: ${result.error}`);
  }
}

const xmtpId = process.argv[2];
if (!xmtpId) {
  console.log("Usage: bun run scripts/simple-push-test.ts <xmtpId>");
  process.exit(1);
}

quickPushTest(xmtpId)
  .then(() => prisma.$disconnect())
  .catch((error: unknown) => {
    console.error(error);
  });
