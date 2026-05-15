import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { __setAgentAssetsApiKeyOverrideForTests } from "@/middleware/agentAuth";
import {
  buildCreditsApp,
  cleanupAccounts,
  seedAccount,
  seedBalance,
  TEST_AGENT_API_KEY,
} from "./helpers";

let BASE = "";
let server: Server;

const tracker: string[] = [];

beforeAll(async () => {
  __setAgentAssetsApiKeyOverrideForTests(TEST_AGENT_API_KEY);
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
  await cleanupAccounts(tracker);
  tracker.length = 0;
});

afterAll(async () => {
  __setAgentAssetsApiKeyOverrideForTests(undefined);
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
});

const headers = (
  overrides: Record<string, string> = {},
): Record<string, string> => ({
  "Content-Type": "application/json",
  "X-Agent-API-Key": TEST_AGENT_API_KEY,
  ...overrides,
});

const post = (path: string, body: unknown, hdrs = headers()) =>
  fetch(`${BASE}${path}`, {
    method: "POST",
    headers: hdrs,
    body: JSON.stringify(body),
  });

describe("POST /api/v2/credits/check", () => {
  test("known account with balance → allowed:true", async () => {
    const accountId = await seedAccount();
    tracker.push(accountId);
    await seedBalance(accountId, 100n);

    const res = await post("/api/v2/credits/check", { accountId });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ allowed: true, balance: "100" });
  });

  test("unknown account → allowed:false, balance:0", async () => {
    const accountId = randomUUID();
    const res = await post("/api/v2/credits/check", { accountId });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ allowed: false, balance: "0" });
  });

  test("missing X-Agent-API-Key → 401", async () => {
    const res = await post(
      "/api/v2/credits/check",
      { accountId: randomUUID() },
      { "Content-Type": "application/json" },
    );
    expect(res.status).toBe(401);
  });

  test("malformed body (accountId not uuid) → 400", async () => {
    const res = await post("/api/v2/credits/check", {
      accountId: "not-a-uuid",
    });
    expect(res.status).toBe(400);
  });

  test("missing accountId → 400", async () => {
    const res = await post("/api/v2/credits/check", {});
    expect(res.status).toBe(400);
  });
});
