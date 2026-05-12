/**
 * Tests for GET /api/v2/agent-templates/generations/:generationId
 *
 * Covers:
 *   - Happy path: terminal row returns full state with templateId
 *   - Pending row returns 200 with status=pending and no templateId
 *   - wait_ms long-polls until terminal
 *   - wait_ms with invalid value → 400
 *   - Cross-account access → 404 (no existence leak)
 *   - Expired row → 404
 *   - Not found → 404
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import {
  __resetGenerationExecutorForTests,
  executeGeneration,
} from "@/api/v2/agent-templates/services/generation-executor";
import { __resetModerationForTests } from "@/api/v2/agent-templates/services/moderation";
import { __resetPostHogForTests } from "@/api/v2/agent-templates/services/posthog";
import {
  __resetGenerateTemplateForTests,
  DEFAULT_TEST_METRICS,
  type GeneratedTemplate,
} from "@/api/v2/agent-templates/services/templateGen";
import { ADMIN_ACCOUNT_ID } from "@/utils/constants";
import { createJwtToken } from "@/utils/jwt";
import { prisma } from "@/utils/prisma";
import {
  startAgentTemplatesServer,
  validAgentAssetsApiKey,
} from "./agent-templates.cross.helpers";

const TEST_PORT = 4076;
const TEST_SOURCE = "generations-get-test";
const OTHER_ACCOUNT_ID = "00000000-0000-4000-8000-bbbbbbbb0001";

const fakeTemplate: GeneratedTemplate = {
  agentName: "Get Test Agent",
  description: "desc",
  prompt: "prompt",
  category: "Test",
  emoji: "📥",
  tools: [],
  connections: [],
};

let baseURL: string;
let closeServer: () => Promise<void>;

beforeAll(async () => {
  process.env.AGENT_ASSETS_API_KEY = validAgentAssetsApiKey;
  __resetPostHogForTests(() => {});
  __resetModerationForTests(() => Promise.resolve({ allowed: true }));
  __resetGenerateTemplateForTests(() =>
    Promise.resolve({
      template: fakeTemplate,
      metrics: DEFAULT_TEST_METRICS,
    }),
  );

  // Ensure the other-account row exists for cross-account tests
  await prisma.account.upsert({
    where: { id: OTHER_ACCOUNT_ID },
    update: {},
    create: { id: OTHER_ACCOUNT_ID },
  });

  const server = await startAgentTemplatesServer(TEST_PORT);
  baseURL = server.baseURL;
  closeServer = server.close;
});

afterEach(async () => {
  __resetGenerationExecutorForTests(null);
  __resetModerationForTests(() => Promise.resolve({ allowed: true }));
  await prisma.agentTemplateGeneration.deleteMany({
    where: { source: TEST_SOURCE },
  });
  await prisma.agentTemplate.deleteMany({
    where: { agentName: fakeTemplate.agentName },
  });
});

afterAll(async () => {
  __resetGenerateTemplateForTests(null);
  __resetPostHogForTests(null);
  __resetModerationForTests(null);
  await prisma.account.delete({ where: { id: OTHER_ACCOUNT_ID } }).catch(() => {
    /* idempotent */
  });
  await closeServer();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const adminHeaders = () => ({ "X-Agent-API-Key": validAgentAssetsApiKey });

const otherAccountHeaders = async () => ({
  "X-Convos-AuthToken": await createJwtToken({
    deviceId: "test-get-cross-account",
    accountId: OTHER_ACCOUNT_ID,
  }),
});

const get = (
  generationId: string,
  opts: { headers?: Record<string, string>; query?: string } = {},
) =>
  fetch(
    `${baseURL}/api/v2/agent-templates/generations/${generationId}${opts.query ?? ""}`,
    { headers: opts.headers ?? adminHeaders() },
  );

const insertGeneration = (
  overrides: Partial<{
    ownerAccountId: string;
    status: "pending" | "running" | "done" | "failed";
    templateId: string | null;
    error: string | null;
    expiresAt: Date | null;
    idempotencyKey: string;
  }> = {},
) =>
  prisma.agentTemplateGeneration.create({
    data: {
      ownerAccountId: overrides.ownerAccountId ?? ADMIN_ACCOUNT_ID,
      source: TEST_SOURCE,
      idempotencyKey: overrides.idempotencyKey ?? `get-test-${Date.now()}-${Math.random()}`,
      inputs: { text: "test" },
      status: overrides.status ?? "pending",
      templateId: overrides.templateId ?? null,
      error: overrides.error ?? null,
      expiresAt: overrides.expiresAt ?? null,
    },
  });

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /generations/:id", () => {
  test("pending row returns 200 with status=pending and no templateId", async () => {
    const gen = await insertGeneration({ status: "pending" });

    const res = await get(gen.id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      generationId: string;
      status: string;
      templateId?: string;
    };
    expect(body.generationId).toBe(gen.id);
    expect(body.status).toBe("pending");
    expect(body.templateId).toBeUndefined();
  });

  test("terminal done row returns 200 with templateId", async () => {
    const template = await prisma.agentTemplate.create({
      data: {
        ownerAccountId: ADMIN_ACCOUNT_ID,
        slug: "get-test-slug",
        agentName: fakeTemplate.agentName,
        prompt: fakeTemplate.prompt,
        status: "draft",
      },
    });
    const gen = await insertGeneration({
      status: "done",
      templateId: template.id,
      expiresAt: new Date(Date.now() + 60_000),
    });

    const res = await get(gen.id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      generationId: string;
      status: string;
      templateId?: string;
    };
    expect(body.status).toBe("done");
    expect(body.templateId).toBe(template.id);
  });

  test("failed row returns 200 with error string", async () => {
    const gen = await insertGeneration({
      status: "failed",
      error: "Generate stage failed: kaboom",
      expiresAt: new Date(Date.now() + 60_000),
    });

    const res = await get(gen.id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; error?: string };
    expect(body.status).toBe("failed");
    expect(body.error).toContain("kaboom");
  });

  test("cross-account access → 404 (no existence leak)", async () => {
    const gen = await insertGeneration({ status: "pending" });

    const headers = await otherAccountHeaders();
    const res = await get(gen.id, { headers });
    expect(res.status).toBe(404);
  });

  test("expired row → 404", async () => {
    const gen = await insertGeneration({
      status: "done",
      expiresAt: new Date(Date.now() - 1_000), // expired
    });

    const res = await get(gen.id);
    expect(res.status).toBe(404);
  });

  test("not found → 404", async () => {
    const res = await get("00000000-0000-4000-8000-deadbeef0001");
    expect(res.status).toBe(404);
  });

  test("invalid wait_ms → 400", async () => {
    const gen = await insertGeneration({ status: "pending" });

    const res = await get(gen.id, { query: "?wait_ms=abc" });
    expect(res.status).toBe(400);
  });

  test("wait_ms long-polls until terminal", async () => {
    const gen = await insertGeneration({ status: "pending" });

    // Schedule the executor to run ~300ms later, marking the row done
    setTimeout(() => {
      void executeGeneration(gen.id);
    }, 200);

    const res = await get(gen.id, { query: "?wait_ms=5000" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; templateId?: string };
    expect(body.status).toBe("done");
    expect(typeof body.templateId).toBe("string");
  });
});
