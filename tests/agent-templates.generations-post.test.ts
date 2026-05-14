/**
 * Tests for POST /api/v2/agent-templates/generations
 *
 * Covers:
 *   - Validation: missing body, bad source, missing inputs                  → 400
 *   - Coalesced input absent                                                 → 400
 *   - Length limits exceeded                                                 → 400
 *   - Missing Idempotency-Key header                                         → 400
 *   - Content moderation blocked                                             → 422
 *   - Happy path (default JSON, no wait_ms)                                  → 202 { generationId }
 *   - Idempotency dedupe: same key + same body → returns existing            → 200 or 202
 *   - Idempotency conflict: same key + different body                        → 409
 *   - wait_ms inline long-poll → returns terminal state                      → 200
 *   - SSE mode (Accept: text/event-stream) → terminal result frame
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
  __setExecutorTimeoutMsForTests,
} from "@/api/v2/agent-templates/services/generation-executor";
import { __resetModerationForTests } from "@/api/v2/agent-templates/services/moderation";
import { __resetPostHogForTests } from "@/api/v2/agent-templates/services/posthog";
import {
  __resetGenerateTemplateForTests,
  DEFAULT_TEST_METRICS,
} from "@/api/v2/agent-templates/services/templateGen";
import { __setAgentAssetsApiKeyOverrideForTests } from "@/middleware/agentAuth";
import { ADMIN_ACCOUNT_ID } from "@/utils/constants";
import { prisma } from "@/utils/prisma";
import {
  stableUuid,
  startAgentTemplatesServer,
  validAgentAssetsApiKey,
} from "./agent-templates.cross.helpers";
import { makeFakeTemplate } from "./agent-templates.generation.helpers";

const TEST_PORT = 4075;
const TEST_SOURCE = "generations-post-test";

const fakeTemplate = makeFakeTemplate({
  agentName: "Post Test Agent",
  description: "desc",
  prompt: "prompt",
});

const baseHeaders = () => ({
  "Content-Type": "application/json",
  "X-Agent-API-Key": validAgentAssetsApiKey,
});

// Tests pass mnemonic labels; `stableUuid` wraps them in a deterministic
// UUIDv5 shape so the same label always yields the same key (required for
// the idempotency replay tests) while still passing the handler's UUID
// validation.
const withKey = (key: string) => ({
  ...baseHeaders(),
  "Idempotency-Key": stableUuid(key),
});

const sampleBody = {
  source: TEST_SOURCE,
  inputs: { text: "build me a productivity assistant" },
};

async function cleanup() {
  await prisma.agentTemplateGeneration.deleteMany({
    where: { ownerAccountId: ADMIN_ACCOUNT_ID, source: TEST_SOURCE },
  });
  await prisma.agentTemplate.deleteMany({
    where: {
      ownerAccountId: ADMIN_ACCOUNT_ID,
      agentName: fakeTemplate.agentName,
    },
  });
}

let baseURL: string;
let closeServer: () => Promise<void>;

beforeAll(async () => {
  __setAgentAssetsApiKeyOverrideForTests(validAgentAssetsApiKey);
  __resetPostHogForTests(() => {});
  __resetModerationForTests(() => Promise.resolve({ allowed: true }));
  __resetGenerateTemplateForTests(() =>
    Promise.resolve({
      template: fakeTemplate,
      metrics: DEFAULT_TEST_METRICS,
    }),
  );

  const server = await startAgentTemplatesServer(TEST_PORT);
  baseURL = server.baseURL;
  closeServer = server.close;
});

afterEach(async () => {
  __resetModerationForTests(() => Promise.resolve({ allowed: true }));
  __setExecutorTimeoutMsForTests(null);
  __resetGenerationExecutorForTests(null);
  await cleanup();
});

afterAll(async () => {
  __resetGenerateTemplateForTests(null);
  __resetPostHogForTests(null);
  __resetModerationForTests(null);
  await closeServer();
});

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

const post = (
  body: unknown,
  opts: { headers?: Record<string, string>; query?: string } = {},
) =>
  fetch(`${baseURL}/api/v2/agent-templates/generations${opts.query ?? ""}`, {
    method: "POST",
    headers: opts.headers ?? withKey("default-key"),
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /generations — validation", () => {
  test("missing source → 400", async () => {
    const res = await post(
      { inputs: { text: "x" } },
      { headers: withKey("v1") },
    );
    expect(res.status).toBe(400);
  });

  test("missing inputs → 400", async () => {
    const res = await post({ source: TEST_SOURCE }, { headers: withKey("v2") });
    expect(res.status).toBe(400);
  });

  test("inputs object empty → 400 (no usable input)", async () => {
    const res = await post(
      { source: TEST_SOURCE, inputs: {} },
      { headers: withKey("v3") },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error.toLowerCase()).toContain("one of");
  });

  test("text exceeds 50_000 chars → 400", async () => {
    const tooLong = "a".repeat(50_001);
    const res = await post(
      { source: TEST_SOURCE, inputs: { text: tooLong } },
      { headers: withKey("v4") },
    );
    expect(res.status).toBe(400);
  });

  test("missing Idempotency-Key → 400", async () => {
    const res = await post(sampleBody, { headers: baseHeaders() });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Idempotency-Key header required");
  });

  test("non-UUID Idempotency-Key → 400", async () => {
    // The agent API key path and anonymous submissions share one idempotency
    // namespace (both owned by ADMIN_ACCOUNT_ID), so the handler requires
    // every key to be a UUID — that's what keeps the shared namespace safe
    // from accidental and adversarial collisions. Any non-UUID string here
    // (a raw tweet ID, a slug, a counter, etc.) must be rejected.
    const res = await post(sampleBody, {
      headers: { ...baseHeaders(), "Idempotency-Key": "1789432100123456789" },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Idempotency-Key must be a UUID");
  });

  test("publishStatus 'archived' → 400 (zod enum gate)", async () => {
    const res = await post(
      { ...sampleBody, publishStatus: "archived" },
      { headers: withKey("publish-status-archived") },
    );
    expect(res.status).toBe(400);
  });

  test("publishStatus 'unlisted' is accepted and persisted on the generation row", async () => {
    __resetGenerationExecutorForTests(() => Promise.resolve());
    const res = await post(
      { ...sampleBody, publishStatus: "unlisted" },
      { headers: withKey("publish-status-unlisted-accept") },
    );
    expect(res.status).toBe(202);
    const body = (await res.json()) as { generationId: string };
    const row = await prisma.agentTemplateGeneration.findUnique({
      where: { id: body.generationId },
    });
    expect(row?.publishStatus).toBe("unlisted");
  });

  test("publishStatus omitted defaults to 'draft' on the persisted row", async () => {
    __resetGenerationExecutorForTests(() => Promise.resolve());
    const res = await post(sampleBody, {
      headers: withKey("publish-status-default"),
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { generationId: string };
    const row = await prisma.agentTemplateGeneration.findUnique({
      where: { id: body.generationId },
    });
    expect(row?.publishStatus).toBe("draft");
  });
});

describe("POST /generations — moderation", () => {
  test("content moderation blocked → 422 with category=content", async () => {
    __resetModerationForTests(() =>
      Promise.resolve({ allowed: false, reason: "blocked" }),
    );

    const res = await post(sampleBody, { headers: withKey("mod-1") });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { reason: string; category: string };
    expect(body.reason).toBe("blocked");
    expect(body.category).toBe("content");

    // No row should have been created
    const rows = await prisma.agentTemplateGeneration.findMany({
      where: { source: TEST_SOURCE, ownerAccountId: ADMIN_ACCOUNT_ID },
    });
    expect(rows).toHaveLength(0);
  });
});

describe("POST /generations — happy path", () => {
  test("default mode returns 202 with generationId", async () => {
    // Suppress the real executor — return immediately so this test focuses on the handler.
    __resetGenerationExecutorForTests(() => Promise.resolve());

    const res = await post(sampleBody, { headers: withKey("happy-1") });
    expect(res.status).toBe(202);
    const body = (await res.json()) as {
      generationId: string;
      status: string;
    };
    expect(typeof body.generationId).toBe("string");
    expect(body.status).toBe("pending");

    const row = await prisma.agentTemplateGeneration.findUnique({
      where: { id: body.generationId },
    });
    expect(row).not.toBeNull();
    expect(row?.source).toBe(TEST_SOURCE);
    expect(row?.idempotencyKey).toBe(stableUuid("happy-1"));
  });

  test("wait_ms long-polls inline → 200 with terminal state + templateId", async () => {
    const res = await post(sampleBody, {
      headers: withKey("wait-1"),
      query: "?wait_ms=10000",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      generationId: string;
      status: string;
      templateId?: string;
    };
    expect(body.status).toBe("done");
    expect(typeof body.templateId).toBe("string");
    expect(body.templateId).toBeTruthy();
  });
});

describe("POST /generations — idempotency", () => {
  test("same key + same body → returns existing row", async () => {
    __resetGenerationExecutorForTests(() => Promise.resolve());

    const first = await post(sampleBody, { headers: withKey("idem-1") });
    expect(first.status).toBe(202);
    const firstBody = (await first.json()) as { generationId: string };

    const second = await post(sampleBody, { headers: withKey("idem-1") });
    // Pending state on second call too (executor was stubbed to no-op)
    expect(second.status).toBe(202);
    const secondBody = (await second.json()) as { generationId: string };

    expect(secondBody.generationId).toBe(firstBody.generationId);
  });

  test("same key + different body → 409", async () => {
    __resetGenerationExecutorForTests(() => Promise.resolve());

    const first = await post(sampleBody, { headers: withKey("idem-2") });
    expect(first.status).toBe(202);

    const altBody = {
      source: TEST_SOURCE,
      inputs: { text: "totally different request" },
    };
    const second = await post(altBody, { headers: withKey("idem-2") });
    expect(second.status).toBe(409);
    const body = (await second.json()) as { error: string };
    expect(body.error.toLowerCase()).toContain("idempotency-key");
  });

  test("terminal generation re-fetch returns 200, not 202", async () => {
    const first = await post(sampleBody, {
      headers: withKey("idem-3"),
      query: "?wait_ms=10000",
    });
    expect(first.status).toBe(200);

    const second = await post(sampleBody, { headers: withKey("idem-3") });
    expect(second.status).toBe(200);
    const body = (await second.json()) as { status: string };
    expect(body.status).toBe("done");
  });
});

describe("POST /generations — SSE mode", () => {
  test("Accept: text/event-stream emits terminal result frame", async () => {
    const res = await fetch(`${baseURL}/api/v2/agent-templates/generations`, {
      method: "POST",
      headers: {
        ...withKey("sse-1"),
        Accept: "text/event-stream",
      },
      body: JSON.stringify(sampleBody),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    // Read the body as text — should contain the terminal frame
    const text = await res.text();
    expect(text).toContain("event: result");
    expect(text).toContain('"status":"done"');
    expect(text).toContain('"templateId":');
  });
});
