import { createApnsService } from "@/api/v2/notifications/apns-push.service";
import { createFcmService } from "@/api/v2/notifications/fcm-push.service";
import type { CreditsRefilledPayload } from "@/api/v2/notifications/types";
import logger from "@/utils/logger";
import { prisma } from "@/utils/prisma";

export type RefilledEntry = {
  accountId: string;
  creditsAdded: number;
  newBalance: bigint;
};

/**
 * Fire-and-forget push fan-out for accounts that were refilled.
 *
 * - Queries non-disabled DeviceRegistrations for the refilled account IDs.
 * - Groups by accountId, then fans out one push per device.
 * - Each device send is individually try/caught — rejections cannot escape.
 * - Returns void; callers use `void fanOutCreditsRefilled(...).catch(...)`.
 */
export async function fanOutCreditsRefilled(
  refilled: RefilledEntry[],
  now: Date,
): Promise<void> {
  if (refilled.length === 0) return;

  const accountIds = refilled.map((r) => r.accountId);

  const devices = await prisma.deviceRegistration.findMany({
    where: {
      accountId: { in: accountIds },
      disabled: false,
      pushToken: { not: null },
    },
    select: {
      deviceId: true,
      accountId: true,
      pushToken: true,
      pushTokenType: true,
      apnsEnv: true,
    },
  });

  if (devices.length === 0) return;

  // Build lookup: accountId → RefilledEntry
  const refilledByAccount = new Map<string, RefilledEntry>(
    refilled.map((r) => [r.accountId, r]),
  );

  // Group devices by accountId
  const devicesByAccount = new Map<string, typeof devices>();
  for (const device of devices) {
    if (!device.accountId) continue;
    const list = devicesByAccount.get(device.accountId) ?? [];
    list.push(device);
    devicesByAccount.set(device.accountId, list);
  }

  // Compute next UTC day midnight for nextRefreshAt
  const nextRefreshAt = new Date(now);
  nextRefreshAt.setUTCHours(0, 0, 0, 0);
  nextRefreshAt.setUTCDate(nextRefreshAt.getUTCDate() + 1);

  const apns = createApnsService();
  const fcm = createFcmService();

  await Promise.all(
    [...devicesByAccount.entries()]
      .flatMap(([accountId, accountDevices]) => {
        const entry = refilledByAccount.get(accountId);
        if (!entry) return [];

        return accountDevices.map((device) => async () => {
          // Adapt DeviceRegistration → ApnsDevice / FcmDevice (id field)
          const adapted = { ...device, id: device.deviceId };

          // Per-device clientId matches v2 routing semantics (see types.ts).
          const payload: CreditsRefilledPayload = {
            clientId: device.deviceId,
            notificationType: "CreditsRefilled",
            notificationData: {
              creditsAdded: entry.creditsAdded,
              newBalance: entry.newBalance.toString(),
              refilledAt: now.toISOString(),
              nextRefreshAt: nextRefreshAt.toISOString(),
            },
          };

          try {
            if (device.pushTokenType === "apns") {
              if (!apns) {
                logger.warn(
                  { deviceId: device.deviceId, accountId },
                  "daily_refill.notify.apns_unavailable",
                );
                return;
              }
              const result = await apns.sendPushNotification({
                device: adapted,
                notification: payload,
                isSilent: true,
              });
              if (!result.success) {
                logger.warn(
                  { deviceId: device.deviceId, accountId, error: result.error },
                  "daily_refill.notify.apns_send_failed",
                );
              }
            } else if (device.pushTokenType === "fcm") {
              if (!fcm) {
                logger.warn(
                  { deviceId: device.deviceId, accountId },
                  "daily_refill.notify.fcm_unavailable",
                );
                return;
              }
              const result = await fcm.sendPushNotification({
                device: adapted,
                notification: payload,
                isSilent: true,
              });
              if (!result.success) {
                logger.warn(
                  { deviceId: device.deviceId, accountId, error: result.error },
                  "daily_refill.notify.fcm_send_failed",
                );
              }
            } else {
              logger.warn(
                {
                  deviceId: device.deviceId,
                  pushTokenType: device.pushTokenType,
                },
                "daily_refill.notify.unknown_token_type",
              );
            }
          } catch (err) {
            logger.warn(
              { err, deviceId: device.deviceId, accountId },
              "daily_refill.notify.send_error",
            );
          }
        });
      })
      .map((fn) => fn()),
  );
}
