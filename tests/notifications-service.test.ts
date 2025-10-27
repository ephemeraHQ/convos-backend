import type { Device } from "@prisma/client";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { rimrafSync } from "rimraf";
import type {
  NotificationPayload,
  ProtocolNotificationData,
} from "@/api/shared/notifications/services/notifications-types";
import {
  getPushNotificationService,
  PushNotificationService,
} from "@/api/shared/notifications/services/push-notification.service";
import { prisma } from "@/utils/prisma";

// Mock functions for APNS service
const mockSendPushNotification = mock<
  (args: {
    device: Device;
    notification: NotificationPayload;
    isSilent?: boolean;
  }) => Promise<{ success: boolean; error?: string }>
>(() => Promise.resolve({ success: true }));

describe("PushNotificationService", () => {
  let testDevice: Device;
  let protocolNotification: NotificationPayload;
  let pushService: PushNotificationService;

  beforeAll(async () => {
    // Clean up any existing test data
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
    // Clean up test databases
    rimrafSync("tests/**/*.db3*", { glob: true });
    mock.restore();
  });

  beforeEach(async () => {
    // Reset mocks before each test
    mockSendPushNotification.mockClear();
    mockSendPushNotification.mockResolvedValue({ success: true });

    // Create a fresh service instance => not breaking the singleton
    pushService = new PushNotificationService();

    // Mock the APNS service on the instance by replacing the private property
    const mockApnsService = {
      sendPushNotification: mockSendPushNotification,
    };
    // @ts-expect-error - Accessing private property for testing
    pushService.apnsService = mockApnsService;

    // Create test device
    testDevice = await prisma.device.create({
      data: {
        id: "test-device-notifications",
        name: "Test Device",
        os: "ios",
        pushToken: "test-apns-token",
        pushTokenType: "apns",
        apnsEnv: "sandbox",
        pushFailures: 0,
        lastPushSuccessAt: null,
      },
    });

    // Create test protocol notification
    const protocolData: ProtocolNotificationData = {
      contentTopic: "/xmtp/mls/1/g-test-group/proto",
      messageType: "v3-conversation",
      encryptedMessage: "encrypted-message-content",
      timestamp: new Date().toISOString(),
    };

    protocolNotification = {
      inboxId: "test-inbox-id",
      notificationType: "Protocol",
      notificationData: protocolData,
    };
  });

  afterEach(async () => {
    // Clean up mocks
    mockSendPushNotification.mockClear();
    await cleanup();
  });

  const cleanup = async () => {
    await prisma.device.deleteMany({
      where: { id: { contains: "test" } },
    });
  };

  // Helper to create test identity on device
  const createTestIdentityOnDevice = (device: Device) => ({
    deviceId: device.id,
    identityId: "test-identity-id",
    xmtpInstallationId: "test-xmtp-installation-id",
    device,
    identity: {
      id: "test-identity-id",
      xmtpId: "test-inbox-id",
      identityAddress: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  });

  describe("sendPushNotification", () => {
    test("successfully sends notification to APNS device", async () => {
      const identityOnDevice = createTestIdentityOnDevice(testDevice);

      const result = await pushService.sendPushNotification({
        identityOnDevice,
        notification: protocolNotification,
      });

      expect(result.success).toBe(true);
      expect(result.shouldCleanup).toBeUndefined();

      // Verify APNS service was called
      expect(mockSendPushNotification).toHaveBeenCalledTimes(1);
      expect(mockSendPushNotification).toHaveBeenCalledWith({
        device: testDevice,
        notification: {
          ...protocolNotification,
          apiJWT: expect.any(String) as string,
        },
      });

      // Verify database was updated - device should have success timestamp and reset failures
      const updatedDevice = await prisma.device.findUnique({
        where: { id: testDevice.id },
      });
      expect(updatedDevice?.pushFailures).toBe(0);
      expect(updatedDevice?.lastPushSuccessAt).not.toBeNull();
    });

    test("skips notification for device with too many failures", async () => {
      // Update device to have too many failures
      await prisma.device.update({
        where: { id: testDevice.id },
        data: { pushFailures: 15 },
      });

      const deviceWithFailures = { ...testDevice, pushFailures: 15 };
      const identityOnDevice = createTestIdentityOnDevice(deviceWithFailures);

      const result = await pushService.sendPushNotification({
        identityOnDevice,
        notification: protocolNotification,
      });

      expect(result.success).toBe(false);
      expect(result.shouldCleanup).toBeUndefined();

      // Verify APNS service was NOT called
      expect(mockSendPushNotification).not.toHaveBeenCalled();
    });

    test("handles APNS failure and increments push failures", async () => {
      // Mock APNS service to return failure
      mockSendPushNotification.mockResolvedValue({
        success: false,
        error: "InvalidPayload",
      });

      const identityOnDevice = createTestIdentityOnDevice(testDevice);

      const result = await pushService.sendPushNotification({
        identityOnDevice,
        notification: protocolNotification,
      });

      expect(result.success).toBe(false);
      expect(result.shouldCleanup).toBe(false);

      // Verify database was updated - failures should be incremented
      const updatedDevice = await prisma.device.findUnique({
        where: { id: testDevice.id },
      });
      expect(updatedDevice?.pushFailures).toBe(1);
      expect(updatedDevice?.lastPushSuccessAt).toBeNull();
    });

    test("marks device for cleanup on bad device token", async () => {
      // Mock APNS service to return bad device token error
      mockSendPushNotification.mockResolvedValue({
        success: false,
        error: "BadDeviceToken",
      });

      const identityOnDevice = createTestIdentityOnDevice(testDevice);

      const result = await pushService.sendPushNotification({
        identityOnDevice,
        notification: protocolNotification,
      });

      expect(result.success).toBe(false);
      expect(result.shouldCleanup).toBe(true);

      // Verify failures were still incremented
      const updatedDevice = await prisma.device.findUnique({
        where: { id: testDevice.id },
      });
      expect(updatedDevice?.pushFailures).toBe(1);
    });

    test("marks device for cleanup on device not registered", async () => {
      // Mock APNS service to return device not registered error
      mockSendPushNotification.mockResolvedValue({
        success: false,
        error: "DeviceNotRegistered",
      });

      const identityOnDevice = createTestIdentityOnDevice(testDevice);

      const result = await pushService.sendPushNotification({
        identityOnDevice,
        notification: protocolNotification,
      });

      expect(result.success).toBe(false);
      expect(result.shouldCleanup).toBe(true);
    });

    test("handles database update errors gracefully", async () => {
      // Create device with invalid ID that will cause database error
      const invalidDevice = {
        ...testDevice,
        id: "non-existent-device-id",
      };

      const identityOnDevice = createTestIdentityOnDevice(invalidDevice);

      const result = await pushService.sendPushNotification({
        identityOnDevice,
        notification: protocolNotification,
      });

      // Should still return success from APNS perspective
      expect(result.success).toBe(true);
      expect(mockSendPushNotification).toHaveBeenCalled();
    });
  });

  describe("sendPushNotificationToXmtpId", () => {
    let testIdentity: { id: string; xmtpId: string };

    beforeEach(async () => {
      // Create test identity
      testIdentity = await prisma.deviceIdentity.create({
        data: {
          xmtpId: "test-inbox-id",
          identityAddress: "0x1234567890",
        },
      });

      // Link identity to device
      await prisma.identitiesOnDevice.create({
        data: {
          deviceId: testDevice.id,
          identityId: testIdentity.id,
          xmtpInstallationId: "test-installation-id",
        },
      });
    });

    afterEach(async () => {
      await prisma.identitiesOnDevice.deleteMany();
      await prisma.deviceIdentity.deleteMany();
    });

    test("successfully sends notification to device by xmtpId", async () => {
      const result = await pushService.sendPushNotificationToXmtpId({
        xmtpId: "test-inbox-id",
        notification: protocolNotification,
      });

      expect(result.success).toBe(true);
      expect(mockSendPushNotification).toHaveBeenCalledTimes(1);
    });

    test("returns failure when no device found for xmtpId", async () => {
      const result = await pushService.sendPushNotificationToXmtpId({
        xmtpId: "non-existent-xmtp-id",
        notification: protocolNotification,
      });

      expect(result.success).toBe(false);
      expect(result.shouldCleanup).toBe(false);
      expect(mockSendPushNotification).not.toHaveBeenCalled();
    });
  });

  describe("singleton service", () => {
    test("getPushNotificationService returns same instance", () => {
      const service1 = getPushNotificationService();
      const service2 = getPushNotificationService();

      expect(service1).toBe(service2);
    });
  });

  describe("APNS service not configured", () => {
    test("handles APNS service not configured", async () => {
      // Create a new service instance and set apnsService to null
      const pushServiceWithoutApns = new PushNotificationService();

      // @ts-expect-error - Accessing private property for testing
      pushServiceWithoutApns.apnsService = null;

      const identityOnDevice = createTestIdentityOnDevice(testDevice);

      const result = await pushServiceWithoutApns.sendPushNotification({
        identityOnDevice,
        notification: protocolNotification,
      });

      expect(result.success).toBe(false);
      expect(mockSendPushNotification).not.toHaveBeenCalled();
    });
  });
});
