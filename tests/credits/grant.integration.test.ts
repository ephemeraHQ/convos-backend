import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
  vi,
} from "vitest";

vi.mock("firebase-admin/app");
vi.mock("firebase-admin/app-check");
vi.mock("firebase-admin/messaging");
vi.mock("jsonwebtoken");

import { __setAgentAssetsApiKeyOverrideForTests } from "@/middleware/agentAuth";
import {
  buildCreditsApp,
  cleanupAccounts,
  seedAccount,
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

describe("POST /api/v2/credits/grant", () => {
  test("happy path → 200 granted + balance + replayed:false", async () => {
    const accountId = await seedAccount();
    tracker.push(accountId);

    const res = await post("/api/v2/credits/grant", {
      accountId,
      credits: 500,
      grantKindId: "signup_bonus",
      idempotencyKey: "idem-grant-1",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      granted: 500,
      balance: "500",
      replayed: false,
    });
  });

  test("idempotent replay → 200 replayed:true + balance unchanged", async () => {
    const accountId = await seedAccount();
    tracker.push(accountId);
    const body = {
      accountId,
      credits: 500,
      grantKindId: "signup_bonus" as const,
      idempotencyKey: "idem-grant-replay-1",
    };
    const first = (await (
      await post("/api/v2/credits/grant", body)
    ).json()) as Record<string, unknown>;
    const second = (await (
      await post("/api/v2/credits/grant", body)
    ).json()) as Record<string, unknown>;
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.granted).toBe(500);
    expect(second.balance).toBe(first.balance);
  });

  test("idempotency mismatch → 409 + code:idempotency_mismatch", async () => {
    const accountId = await seedAccount();
    tracker.push(accountId);

    // First grant: 500 credits, key X
    await post("/api/v2/credits/grant", {
      accountId,
      credits: 500,
      grantKindId: "signup_bonus",
      idempotencyKey: "idem-grant-mismatch-1",
    });
    // Second grant: same key, different credits amount → mismatch
    const res = await post("/api/v2/credits/grant", {
      accountId,
      credits: 999,
      grantKindId: "signup_bonus",
      idempotencyKey: "idem-grant-mismatch-1",
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe("idempotency_mismatch");
  });

  test("unknown account → 409 + code:account_not_found", async () => {
    const res = await post("/api/v2/credits/grant", {
      accountId: randomUUID(),
      credits: 500,
      grantKindId: "signup_bonus",
      idempotencyKey: "idem-grant-ghost-1",
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe("account_not_found");
  });

  test("grantKindId not in allowed set → 400", async () => {
    const accountId = await seedAccount();
    tracker.push(accountId);
    const res = await post("/api/v2/credits/grant", {
      accountId,
      credits: 500,
      grantKindId: "daily_refill",
      idempotencyKey: "idem-grant-bad-kind-1",
    });
    expect(res.status).toBe(400);
  });

  test("missing X-Agent-API-Key → 401", async () => {
    const res = await post(
      "/api/v2/credits/grant",
      {
        accountId: randomUUID(),
        credits: 500,
        grantKindId: "signup_bonus",
        idempotencyKey: "idem-grant-noauth-1",
      },
      { "Content-Type": "application/json" },
    );
    expect(res.status).toBe(401);
  });
});
