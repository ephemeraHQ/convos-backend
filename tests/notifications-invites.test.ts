import type { Server } from "http";
import { DeviceOS, type InviteCode } from "@prisma/client";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import express from "express";
import { rimrafSync } from "rimraf";
import type { RequestToJoinRequestBody } from "@/api/v1/invites/handlers/request-to-join";
import invitesRouter from "@/api/v1/invites/invites.router";
import type {
  InviteJoinRequestNotificationData,
  NotificationPayload,
} from "@/api/v1/notifications/services/notifications-types";
import * as PushService from "@/api/v1/notifications/services/push-notification.service";
import { jsonMiddleware } from "@/middleware/json";
import { pinoMiddleware } from "@/middleware/pino";
import { prisma } from "@/utils/prisma";

// Mock functions for push notification service
const mockSendPushNotificationToXmtpId = mock<
  (args: {
    xmtpId: string;
    notification: NotificationPayload;
  }) => Promise<{ success: boolean }>
>(() => Promise.resolve({ success: true }));

describe("Invite Notifications Integration", () => {
  let app: express.Application;
  let server: Server;
  let inviteCode: InviteCode;

  beforeAll(() => {
    // Set up Express app
    app = express();
    app.use(pinoMiddleware);
    app.use(jsonMiddleware);

    // Mock authentication middleware
    app.use((req, _res, next) => {
      const overrideXmtpId = req.headers["x-test-xmtp-id"];
      _res.locals.xmtpId =
        typeof overrideXmtpId === "string"
          ? overrideXmtpId
          : "test-default-xmtp-id";
      _res.locals.xmtpInstallationId = "test-installation-id";
      next();
    });

    app.use("/invites", invitesRouter);
    server = app.listen(3015);
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
    server.close();
    rimrafSync("tests/**/*.db3*", { glob: true });
    // Restore all mocks
    mock.restore();
  });

  beforeEach(async () => {
    // Clear and reset mocks
    mockSendPushNotificationToXmtpId.mockClear();
    mockSendPushNotificationToXmtpId.mockResolvedValue({ success: true });

    // Spy on the specific methods we care about on the actual service
    const pushService = PushService.getPushNotificationService();
    spyOn(pushService, "sendPushNotificationToXmtpId").mockImplementation(
      mockSendPushNotificationToXmtpId,
    );
    spyOn(pushService, "sendPushNotification").mockResolvedValue({
      success: true,
    });

    // Create test data
    inviteCode = await setupTestData();
  });

  afterEach(async () => {
    // Clean up mocks
    mockSendPushNotificationToXmtpId.mockClear();
    mock.restore();
    await cleanup();
  });

  const cleanup = async () => {
    await prisma.inviteCodeNotificationTarget.deleteMany();
    await prisma.inviteCodeRequest.deleteMany();
    await prisma.inviteCodeUse.deleteMany();
    await prisma.inviteCode.deleteMany();
    await prisma.identitiesOnDevice.deleteMany();
    await prisma.deviceIdentity.deleteMany();
    await prisma.device.deleteMany();
  };

  const setupTestData = async (): Promise<InviteCode> => {
    // Create invite creator identity and device
    const creatorIdentity = await prisma.deviceIdentity.create({
      data: {
        xmtpId: "test-creator-xmtp-id-notifications",
        identityAddress: "0x1234creator",
      },
    });
    const creatorDevice = await prisma.device.create({
      data: {
        id: "test-device-creator-notifications",
        os: DeviceOS.ios,
        name: "Creator Device",
        pushToken: "creator-push-token",
        pushTokenType: "apns",
        apnsEnv: "sandbox",
      },
    });
    await prisma.identitiesOnDevice.create({
      data: {
        deviceId: creatorDevice.id,
        identityId: creatorIdentity.id,
      },
    });

    // Create requester identity and device
    const requesterIdentity = await prisma.deviceIdentity.create({
      data: {
        xmtpId: "test-requester-xmtp-id-notifications",
        identityAddress: "0x1234requester",
      },
    });
    const requesterDevice = await prisma.device.create({
      data: {
        id: "test-device-requester-notifications",
        os: DeviceOS.android,
        name: "Requester Device",
        pushToken: "requester-push-token",
        pushTokenType: "apns",
        apnsEnv: "sandbox",
      },
    });
    await prisma.identitiesOnDevice.create({
      data: {
        deviceId: requesterDevice.id,
        identityId: requesterIdentity.id,
      },
    });

    // Create notification target identity and device
    const notifyIdentity = await prisma.deviceIdentity.create({
      data: {
        xmtpId: "test-notification-target-xmtp-id",
        identityAddress: "0x1234notificationtarget",
      },
    });
    const notifyDevice = await prisma.device.create({
      data: {
        id: "test-device-notification-target",
        os: DeviceOS.ios,
        name: "Notification Target Device",
        pushToken: "notification-target-push-token",
        pushTokenType: "apns",
        apnsEnv: "sandbox",
      },
    });
    await prisma.identitiesOnDevice.create({
      data: {
        deviceId: notifyDevice.id,
        identityId: notifyIdentity.id,
      },
    });

    // Create invite code
    const createdInviteCode = await prisma.inviteCode.create({
      data: {
        groupId: "test-group-notifications-123",
        name: "Test Notification Group Invite",
        description: "Test invite for notification testing",
        autoApprove: false, // Require approval to trigger notifications
        createdById: creatorIdentity.id,
      },
    });

    // Get notification target identity
    const notificationTargetIdentity = await prisma.deviceIdentity.findFirst({
      where: { xmtpId: "test-notification-target-xmtp-id" },
    });

    // Add notification target to the invite
    await prisma.inviteCodeNotificationTarget.create({
      data: {
        inviteCodeId: createdInviteCode.id,
        deviceIdentityId: notificationTargetIdentity!.id,
      },
    });

    return createdInviteCode;
  };

  test("sends push notification when user requests to join invite", async () => {
    const requestBody: RequestToJoinRequestBody = {
      inviteId: inviteCode.id,
    };

    // Make API request as the requester
    const response = await fetch("http://localhost:3015/invites/request", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-test-xmtp-id": "test-requester-xmtp-id-notifications",
      },
      body: JSON.stringify(requestBody),
    });

    expect(response.status).toBe(201);

    // Verify push notifications were sent to both creator and notification target
    expect(mockSendPushNotificationToXmtpId).toHaveBeenCalledTimes(2);

    const calls = mockSendPushNotificationToXmtpId.mock.calls;
    const sentToXmtpIds = calls.map((call) => call[0].xmtpId);

    // Verify notifications were sent to both creator and notification target
    expect(sentToXmtpIds).toContain("test-creator-xmtp-id-notifications");
    expect(sentToXmtpIds).toContain("test-notification-target-xmtp-id");

    // Verify notification payload structure (check first call)
    const firstCall = calls[0][0];
    const notification = firstCall.notification;
    expect(notification.notificationType).toBe("InviteJoinRequest");

    // Verify notification data structure
    const notificationData =
      notification.notificationData as InviteJoinRequestNotificationData;
    expect(notificationData.id).toBeDefined();
    expect(notificationData.createdAt).toBeDefined();
    expect(notificationData.updatedAt).toBeDefined();
    expect(notificationData.autoApprove).toBe(false);

    // Verify requester data
    expect(notificationData.requester.xmtpId).toBe(
      "test-requester-xmtp-id-notifications",
    );
    expect(notificationData.requester.profile?.name).toBe("Test Requester");
    expect(notificationData.requester.profile?.username).toBe("testrequester");
    expect(notificationData.requester.profile?.description).toBe(
      "Test requester user",
    );

    // Verify invite code data
    expect(notificationData.inviteCode.id).toBe(inviteCode.id);
    expect(notificationData.inviteCode.name).toBe(
      "Test Notification Group Invite",
    );
    expect(notificationData.inviteCode.description).toBe(
      "Test invite for notification testing",
    );
    expect(notificationData.inviteCode.groupId).toBe(
      "test-group-notifications-123",
    );
  });
});
