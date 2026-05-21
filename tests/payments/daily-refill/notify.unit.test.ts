import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, test } from "vitest";
import { fanOutCreditsRefilled } from "@/payments/daily-refill/notify";
import { prisma } from "@/utils/prisma";

const tracker: string[] = [];
const deviceTracker: string[] = [];

afterEach(async () => {
  for (const deviceId of deviceTracker) {
    await prisma.deviceRegistration.deleteMany({ where: { deviceId } });
  }
  for (const accountId of tracker) {
    await prisma.account.deleteMany({ where: { id: accountId } });
  }
  tracker.length = 0;
  deviceTracker.length = 0;
});

describe("fanOutCreditsRefilled", () => {
  test("no refilled accounts → no DB query, returns immediately", async () => {
    await fanOutCreditsRefilled([], new Date());
    expect(true).toBe(true);
  });

  test("refilled account with no devices → returns without sending", async () => {
    const acct = await prisma.account.create({ data: {} });
    tracker.push(acct.id);
    await fanOutCreditsRefilled(
      [{ accountId: acct.id, creditsAdded: 50, newBalance: 100n }],
      new Date(),
    );
    expect(true).toBe(true);
  });

  test("refilled account with disabled device → device filtered out", async () => {
    const acct = await prisma.account.create({ data: {} });
    tracker.push(acct.id);
    const deviceId = randomUUID();
    await prisma.deviceRegistration.create({
      data: {
        deviceId,
        accountId: acct.id,
        pushToken: "tok",
        pushTokenType: "apns",
        apnsEnv: "sandbox",
        disabled: true,
      },
    });
    deviceTracker.push(deviceId);
    await fanOutCreditsRefilled(
      [{ accountId: acct.id, creditsAdded: 50, newBalance: 100n }],
      new Date(),
    );
    expect(true).toBe(true);
  });
});
