import type { Server } from "node:http";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { __setCronApiKeyOverrideForTests } from "@/api/v2/credits/middleware/cron-api-key";
import { prisma } from "@/utils/prisma";
import {
  buildCreditsApp,
  cleanupAccounts,
  seedAccount,
} from "./helpers";

const TEST_CRON_KEY = "test-cron-api-key-that-is-at-least-32-characters-long";

let BASE = "";
let server: Server;
const tracker: string[] = [];

beforeAll(async () => {
  __setCronApiKeyOverrideForTests(TEST_CRON_KEY);
  const app = buildCreditsApp();
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        throw new Error("Failed to resolve test server address");
      }
      BASE = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

afterEach(async () => {
  // Delete AuthMethod rows first (FK child of Account) so cleanupAccounts can delete Account
  if (tracker.length > 0) {
    await prisma.authMethod.deleteMany({
      where: { accountId: { in: tracker } },
    });
  }
  await cleanupAccounts(tracker);
  tracker.length = 0;
});

afterAll(async () => {
  __setCronApiKeyOverrideForTests(undefined);
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
});

const post = (path: string, hdrs: Record<string, string> = {}) =>
  fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...hdrs },
  });

describe("POST /api/v2/credits/daily", () => {
  test("missing X-Cron-API-Key → 401", async () => {
    const res = await post("/api/v2/credits/daily");
    expect(res.status).toBe(401);
  });

  test("wrong X-Cron-API-Key → 401", async () => {
    const res = await post("/api/v2/credits/daily", {
      "X-Cron-API-Key": "wrong-key-that-is-also-at-least-32-characters-long",
    });
    expect(res.status).toBe(401);
  });

  test("correct key + fresh accounts → 200 with counts", async () => {
    // Seed an account with an auth method so it appears in eligible query
    const accountId = await seedAccount();
    tracker.push(accountId);
    // Add a SIWE auth method so the account is eligible
    await prisma.authMethod.create({
      data: {
        accountId,
        type: "SIWE",
        externalKey: `0xtest-daily-refill-${accountId}`,
      },
    });

    const res = await post("/api/v2/credits/daily", {
      "X-Cron-API-Key": TEST_CRON_KEY,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.skipped).toBe(false);
    expect(typeof body.refilled).toBe("number");
    expect(typeof body.noOp).toBe("number");
    expect(typeof body.errors).toBe("number");
    expect(typeof body.runAt).toBe("string");
    // Our seeded account has no balance, so it should be refilled
    expect(body.refilled as number).toBeGreaterThanOrEqual(1);
  });

  test("second call same UTC day → 200 skipped:true", async () => {
    // First call
    const res1 = await post("/api/v2/credits/daily", {
      "X-Cron-API-Key": TEST_CRON_KEY,
    });
    expect(res1.status).toBe(200);
    const body1 = (await res1.json()) as Record<string, unknown>;
    // May have been skipped from a prior test's run — either way, do a second call
    if (body1.skipped) {
      // Already skipped from prior run — second call must also skip
    }

    // Second call — must be skipped (already_ran_today guard)
    const res2 = await post("/api/v2/credits/daily", {
      "X-Cron-API-Key": TEST_CRON_KEY,
    });
    expect(res2.status).toBe(200);
    const body2 = (await res2.json()) as Record<string, unknown>;
    expect(body2.skipped).toBe(true);
    expect(body2.reason).toBe("already_ran_today");
    expect(typeof body2.lastRunAt).toBe("string");
  });
});
