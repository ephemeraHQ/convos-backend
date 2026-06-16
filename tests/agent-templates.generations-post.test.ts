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

import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import {
  __resetGenerationExecutorForTests,
  __setExecutorTimeoutMsForTests,
} from "@/api/v2/agent-templates/services/generation-executor";
import { __resetModerationForTests } from "@/api/v2/agent-templates/services/moderation";
import { __setOpenRouterModelsForTests } from "@/api/v2/agent-templates/services/openrouter-models";
import { __resetPostHogForTests } from "@/api/v2/agent-templates/services/posthog";
import {
  __resetGenerateTemplateForTests,
  DEFAULT_TEST_METRICS,
} from "@/api/v2/agent-templates/services/templateGen";
import { GENERATION_ESTIMATE_MS } from "@/config";
import { __setAgentAssetsApiKeyOverrideForTests } from "@/middleware/agentAuth";
import { ADMIN_ACCOUNT_ID } from "@/utils/constants";
import { createJwtToken } from "@/utils/jwt";
import { prisma } from "@/utils/prisma";
import {
  stableUuid,
  startAgentTemplatesServer,
  validAgentAssetsApiKey,
} from "./agent-templates.cross.helpers";
import { makeFakeTemplate } from "./agent-templates.generation.helpers";

// Dedicated user account for owner-assertion tests. Created in beforeAll
// so the agent-key-auth path can assert it via `body.ownerAccountId`, and
// the JWT path can authenticate as it. UUID is stable across runs.
const ASSERTED_ACCOUNT_ID = "00000000-0000-4000-8000-cccccccc0001";
const NONEXISTENT_ACCOUNT_ID = "00000000-0000-4000-8000-deaddead0001";

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
    where: {
      ownerAccountId: { in: [ADMIN_ACCOUNT_ID, ASSERTED_ACCOUNT_ID] },
      source: TEST_SOURCE,
    },
  });
  await prisma.agentTemplate.deleteMany({
    where: {
      ownerAccountId: { in: [ADMIN_ACCOUNT_ID, ASSERTED_ACCOUNT_ID] },
      agentName: { in: [fakeTemplate.agentName, "Renamed Agent"] },
    },
  });
}

let baseURL: string;
let closeServer: () => Promise<void>;

beforeAll(async () => {
  __setAgentAssetsApiKeyOverrideForTests(validAgentAssetsApiKey);
  __resetPostHogForTests(() => {});
  __resetModerationForTests(() => Promise.resolve({ allowed: true }));
  // Fixed model catalog so builderModel validation is hermetic (no network).
  __setOpenRouterModelsForTests([
    "anthropic/claude-opus-4.8",
    "anthropic/claude-opus-4.7",
  ]);
  __resetGenerateTemplateForTests(() =>
    Promise.resolve({
      template: fakeTemplate,
      metrics: DEFAULT_TEST_METRICS,
    }),
  );

  // Owner-assertion tests need a real account row to assert against.
  await prisma.account.upsert({
    where: { id: ASSERTED_ACCOUNT_ID },
    update: {},
    create: { id: ASSERTED_ACCOUNT_ID },
  });

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
  __setOpenRouterModelsForTests(null);
  // Restore the singleton agent-key override so it can't leak into other suites.
  __setAgentAssetsApiKeyOverrideForTests(undefined);
  await prisma.account
    .delete({ where: { id: ASSERTED_ACCOUNT_ID } })
    .catch(() => {
      /* idempotent */
    });
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
    expect(body.error.toLowerCase()).toContain("attachment");
  });

  test("text exceeds 50_000 chars → 400", async () => {
    const tooLong = "a".repeat(50_001);
    const res = await post(
      { source: TEST_SOURCE, inputs: { text: tooLong } },
      { headers: withKey("v4") },
    );
    expect(res.status).toBe(400);
  });

  test("intent text exceeds 50_000 chars on an attachment path → 400", async () => {
    // The intent text rides along with an attachment (the generator uses it as
    // the files' directive), so it's length-capped there too — and the check
    // fires before any S3 work, so the unfetchable objectKey is never touched.
    const tooLong = "a".repeat(50_001);
    const res = await post(
      {
        source: TEST_SOURCE,
        inputs: {
          attachments: [{ objectKey: "build/x.png", mimeType: "image/png" }],
          text: tooLong,
        },
      },
      { headers: withKey("v4-file-intent") },
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
      estimatedDurationMs?: number;
    };
    expect(typeof body.generationId).toBe("string");
    expect(body.status).toBe("pending");
    // The fresh-submit 202 carries the build-time estimate even before the
    // executor writes any preview (text-only inputs → the base estimate).
    expect(body.estimatedDurationMs).toBe(GENERATION_ESTIMATE_MS);

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

  test("same key + different prefill → 409 (must not cross-link)", async () => {
    // The prefill influences the generator's output, so two callers
    // sharing an Idempotency-Key but pinning different values must not
    // be deduplicated — the second caller would otherwise receive an
    // AgentTemplate built with the first caller's pinned values, which
    // is the wrong result.
    __resetGenerationExecutorForTests(() => Promise.resolve());

    const first = await post(
      { ...sampleBody, prefill: { agentName: "Alice" } },
      { headers: withKey("idem-prefill-diff") },
    );
    expect(first.status).toBe(202);

    const second = await post(
      { ...sampleBody, prefill: { agentName: "Bob" } },
      { headers: withKey("idem-prefill-diff") },
    );
    expect(second.status).toBe(409);
  });

  test("same key + same prefill → dedupes (replay)", async () => {
    // Sanity check: when the prefill DOES match, the replay path works
    // as before — same generationId returned, no 409.
    __resetGenerationExecutorForTests(() => Promise.resolve());

    const pinned = {
      ...sampleBody,
      prefill: { agentName: "Alice", emoji: "🦊" },
    };

    const first = await post(pinned, {
      headers: withKey("idem-prefill-match"),
    });
    expect(first.status).toBe(202);
    const firstBody = (await first.json()) as { generationId: string };

    const second = await post(pinned, {
      headers: withKey("idem-prefill-match"),
    });
    expect(second.status).toBe(202);
    const secondBody = (await second.json()) as { generationId: string };

    expect(secondBody.generationId).toBe(firstBody.generationId);
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

describe("POST /generations — builderPrompt (privileged override)", () => {
  test("anonymous caller + builderPrompt → 403", async () => {
    // builderPrompt overrides the canonical generator prompt, so like
    // twitterContext it's restricted to agent-API-key callers.
    const res = await post(
      { ...sampleBody, builderPrompt: "You are a custom builder." },
      {
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": stableUuid("builder-anon"),
        },
      },
    );
    expect(res.status).toBe(403);
  });

  test("agent-key + builderPrompt → 202 and persists on the row", async () => {
    __resetGenerationExecutorForTests(() => Promise.resolve());
    const res = await post(
      { ...sampleBody, builderPrompt: "You are a custom builder." },
      { headers: withKey("builder-ok") },
    );
    expect(res.status).toBe(202);
    const body = (await res.json()) as { generationId: string };
    const row = await prisma.agentTemplateGeneration.findUnique({
      where: { id: body.generationId },
    });
    expect(row?.builderPrompt).toBe("You are a custom builder.");
  });

  test("same key + different builderPrompt → 409", async () => {
    // builderPrompt influences the generator's output, so it's part of the
    // idempotent contract — a reused key with a different prompt must 409.
    __resetGenerationExecutorForTests(() => Promise.resolve());
    const first = await post(
      { ...sampleBody, builderPrompt: "Prompt A" },
      { headers: withKey("idem-builder-diff") },
    );
    expect(first.status).toBe(202);

    const second = await post(
      { ...sampleBody, builderPrompt: "Prompt B" },
      { headers: withKey("idem-builder-diff") },
    );
    expect(second.status).toBe(409);
  });
});

describe("POST /generations — builderModel (privileged override)", () => {
  test("anonymous caller + builderModel → 403", async () => {
    // builderModel swaps the default builder model, so like builderPrompt
    // it's restricted to agent-API-key callers.
    const res = await post(
      { ...sampleBody, builderModel: "anthropic/claude-opus-4.8" },
      {
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": stableUuid("builder-model-anon"),
        },
      },
    );
    expect(res.status).toBe(403);
  });

  test("agent-key + builderModel → 202 and persists on the row", async () => {
    __resetGenerationExecutorForTests(() => Promise.resolve());
    const res = await post(
      { ...sampleBody, builderModel: "anthropic/claude-opus-4.8" },
      { headers: withKey("builder-model-ok") },
    );
    expect(res.status).toBe(202);
    const body = (await res.json()) as { generationId: string };
    const row = await prisma.agentTemplateGeneration.findUnique({
      where: { id: body.generationId },
    });
    expect(row?.builderModel).toBe("anthropic/claude-opus-4.8");
  });

  test("agent-key + builderModel unknown to OpenRouter → 400", async () => {
    // Submit-time catalog validation fails fast rather than letting the bad
    // model surface later as a terminal `failed` generation.
    __resetGenerationExecutorForTests(() => Promise.resolve());
    const res = await post(
      { ...sampleBody, builderModel: "anthropic/claude-opus-9.9-imaginary" },
      { headers: withKey("builder-model-unknown") },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("is not a valid OpenRouter model");
  });

  test("same key + different builderModel → 409", async () => {
    // builderModel influences the generator's output, so it's part of the
    // idempotent contract — a reused key with a different model must 409.
    __resetGenerationExecutorForTests(() => Promise.resolve());
    const first = await post(
      { ...sampleBody, builderModel: "anthropic/claude-opus-4.8" },
      { headers: withKey("idem-builder-model-diff") },
    );
    expect(first.status).toBe(202);

    const second = await post(
      { ...sampleBody, builderModel: "anthropic/claude-opus-4.7" },
      { headers: withKey("idem-builder-model-diff") },
    );
    expect(second.status).toBe(409);
  });
});

describe("POST /generations — connections (open capability flag)", () => {
  test("unknown connection → 400", async () => {
    const res = await post(
      { ...sampleBody, connections: ["not_a_real_service"] },
      { headers: withKey("conn-unknown") },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("Unknown connection");
  });

  test("valid connections → 202 and persist raw on the row (no auth gate)", async () => {
    __resetGenerationExecutorForTests(() => Promise.resolve());
    // Anonymous (no agent key): unlike builderPrompt/builderModel, stamping a
    // connection grants nothing, so it is NOT restricted to agent-key callers.
    const res = await post(
      { ...sampleBody, connections: ["googlecalendar"] },
      {
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": stableUuid("conn-ok-anon"),
        },
      },
    );
    expect(res.status).toBe(202);
    const body = (await res.json()) as { generationId: string };
    const row = await prisma.agentTemplateGeneration.findUnique({
      where: { id: body.generationId },
    });
    expect(row?.connections).toEqual(["googlecalendar"]);
  });

  test("no connections → row.connections defaults to []", async () => {
    __resetGenerationExecutorForTests(() => Promise.resolve());
    const res = await post(sampleBody, { headers: withKey("conn-absent") });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { generationId: string };
    const row = await prisma.agentTemplateGeneration.findUnique({
      where: { id: body.generationId },
    });
    expect(row?.connections).toEqual([]);
  });

  test("same key + different connections → 409", async () => {
    // connections influence the generator's output (capabilities directive) and
    // the persisted template, so they are part of the idempotent contract.
    __resetGenerationExecutorForTests(() => Promise.resolve());
    const first = await post(
      { ...sampleBody, connections: ["googlecalendar"] },
      { headers: withKey("idem-conn-diff") },
    );
    expect(first.status).toBe(202);

    const second = await post(sampleBody, {
      headers: withKey("idem-conn-diff"),
    });
    expect(second.status).toBe(409);
  });

  test("same key + same connections → dedupes (no spurious 409)", async () => {
    __resetGenerationExecutorForTests(() => Promise.resolve());
    const first = await post(
      { ...sampleBody, connections: ["googlecalendar"] },
      { headers: withKey("idem-conn-match") },
    );
    expect(first.status).toBe(202);

    const second = await post(
      { ...sampleBody, connections: ["googlecalendar"] },
      { headers: withKey("idem-conn-match") },
    );
    expect([200, 202]).toContain(second.status);
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

// ---------------------------------------------------------------------------
// Caller-pinned prefill + owner assertion
// ---------------------------------------------------------------------------

describe("POST /generations — prefill", () => {
  test("agentName / emoji / description overlay the generator's output", async () => {
    const res = await post(
      {
        ...sampleBody,
        prefill: {
          agentName: "Renamed Agent",
          emoji: "🦊",
          description: "A pinned description.",
        },
      },
      { headers: withKey("prefill-overlay"), query: "?wait_ms=10000" },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      templateId?: string;
    };
    expect(body.status).toBe("done");

    const template = await prisma.agentTemplate.findUnique({
      where: { id: body.templateId },
    });
    expect(template).not.toBeNull();
    // Caller-pinned values win over whatever the mocked generator
    // emitted (`makeFakeTemplate({ agentName: "Post Test Agent", ... })`).
    expect(template?.agentName).toBe("Renamed Agent");
    expect(template?.emoji).toBe("🦊");
    expect(template?.description).toBe("A pinned description.");
  });

  test("partial prefill — only set fields overlay; others keep generator output", async () => {
    const res = await post(
      { ...sampleBody, prefill: { emoji: "🌶️" } },
      { headers: withKey("prefill-partial"), query: "?wait_ms=10000" },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { templateId?: string };

    const template = await prisma.agentTemplate.findUnique({
      where: { id: body.templateId },
    });
    expect(template?.emoji).toBe("🌶️");
    // agentName + description fall through to the mocked generator
    expect(template?.agentName).toBe(fakeTemplate.agentName);
    expect(template?.description).toBe(fakeTemplate.description);
  });

  test("prefill persists on the generation row's prefill column", async () => {
    __resetGenerationExecutorForTests(() => Promise.resolve());

    const res = await post(
      { ...sampleBody, prefill: { agentName: "Renamed Agent", emoji: "🦊" } },
      { headers: withKey("prefill-persist") },
    );
    expect(res.status).toBe(202);
    const body = (await res.json()) as { generationId: string };

    const row = await prisma.agentTemplateGeneration.findUnique({
      where: { id: body.generationId },
    });
    expect(row?.prefill).toEqual({
      agentName: "Renamed Agent",
      emoji: "🦊",
    });
  });

  test("no prefill → prefill column is null", async () => {
    __resetGenerationExecutorForTests(() => Promise.resolve());

    const res = await post(sampleBody, {
      headers: withKey("prefill-absent"),
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { generationId: string };

    const row = await prisma.agentTemplateGeneration.findUnique({
      where: { id: body.generationId },
    });
    expect(row?.prefill).toBeNull();
  });

  test("empty {} prefill is treated as omitted (no spurious 409, persists null)", async () => {
    // `{}` overlays nothing, so it's semantically identical to an
    // omitted prefill. The handler normalises it at parse time so the
    // dedupe contract treats them as the same body, and the row stores
    // null (not `{}`) for the empty case.
    __resetGenerationExecutorForTests(() => Promise.resolve());

    const a = await post(sampleBody, { headers: withKey("idem-empty-1") });
    const b = await post(
      { ...sampleBody, prefill: {} },
      { headers: withKey("idem-empty-1") },
    );

    expect(a.status).toBe(202);
    expect(b.status).toBe(202);
    const aBody = (await a.json()) as { generationId: string };
    const bBody = (await b.json()) as { generationId: string };
    // Same logical body → dedupe replay, not 409.
    expect(bBody.generationId).toBe(aBody.generationId);

    const row = await prisma.agentTemplateGeneration.findUnique({
      where: { id: aBody.generationId },
    });
    expect(row?.prefill).toBeNull();
  });

  test("rejects keys outside the prefill allowlist → 400", async () => {
    // `TemplatePrefillSchema` is `.strict()` so a caller can't pin
    // server-managed fields (slug, id, status, ownerAccountId, …) by
    // sneaking them in alongside the allowed ones. New pinnable fields
    // go through `TemplatePrefillSchema` explicitly; the wire surface
    // stays a stable allowlist.
    const res = await post(
      {
        ...sampleBody,
        prefill: { agentName: "Allowed", slug: "not-allowed" },
      },
      { headers: withKey("prefill-strict") },
    );
    expect(res.status).toBe(400);
  });
});

describe("POST /generations — owner assertion", () => {
  test("agent-key auth + body.ownerAccountId → row owner is the asserted account", async () => {
    __resetGenerationExecutorForTests(() => Promise.resolve());

    const res = await post(
      { ...sampleBody, ownerAccountId: ASSERTED_ACCOUNT_ID },
      { headers: withKey("owner-asserted") },
    );
    expect(res.status).toBe(202);
    const body = (await res.json()) as { generationId: string };

    const row = await prisma.agentTemplateGeneration.findUnique({
      where: { id: body.generationId },
    });
    expect(row?.ownerAccountId).toBe(ASSERTED_ACCOUNT_ID);
  });

  test("agent-key auth without assertion → row owner falls back to ADMIN", async () => {
    __resetGenerationExecutorForTests(() => Promise.resolve());

    const res = await post(sampleBody, { headers: withKey("owner-default") });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { generationId: string };

    const row = await prisma.agentTemplateGeneration.findUnique({
      where: { id: body.generationId },
    });
    expect(row?.ownerAccountId).toBe(ADMIN_ACCOUNT_ID);
  });

  test("agent-key auth + body.ownerAccountId referring to a missing account → 400", async () => {
    // Covers the common case (account never existed → pre-check fails
    // → 400). The TOCTOU variant (account deleted between pre-check
    // and insert → FK violation → 400) is harder to exercise without
    // mocking `prisma.create` to throw P2003 on demand, but the catch
    // block in the handler maps the same error to the same 400 via the
    // FK constraint, so consistency holds across race timings.
    const res = await post(
      { ...sampleBody, ownerAccountId: NONEXISTENT_ACCOUNT_ID },
      { headers: withKey("owner-asserted-invalid") },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error.toLowerCase()).toContain("ownerAccountId".toLowerCase());

    // No row created
    const rows = await prisma.agentTemplateGeneration.findMany({
      where: { source: TEST_SOURCE },
    });
    expect(rows).toHaveLength(0);
  });

  test("JWT auth + body.ownerAccountId → JWT account wins, body field ignored", async () => {
    __resetGenerationExecutorForTests(() => Promise.resolve());

    const jwt = await createJwtToken({
      deviceId: "owner-assertion-jwt",
      accountId: ASSERTED_ACCOUNT_ID,
    });
    // Body asserts ADMIN — must be ignored because JWT auth wins.
    const res = await fetch(`${baseURL}/api/v2/agent-templates/generations`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Convos-AuthToken": jwt,
        "Idempotency-Key": stableUuid("owner-jwt-ignores-body"),
      },
      body: JSON.stringify({
        ...sampleBody,
        ownerAccountId: ADMIN_ACCOUNT_ID,
      }),
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { generationId: string };

    const row = await prisma.agentTemplateGeneration.findUnique({
      where: { id: body.generationId },
    });
    expect(row?.ownerAccountId).toBe(ASSERTED_ACCOUNT_ID);
  });

  test("anonymous + body.ownerAccountId → ADMIN, body field ignored", async () => {
    __resetGenerationExecutorForTests(() => Promise.resolve());

    const res = await fetch(`${baseURL}/api/v2/agent-templates/generations`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": stableUuid("owner-anon-ignores-body"),
      },
      body: JSON.stringify({
        ...sampleBody,
        ownerAccountId: ASSERTED_ACCOUNT_ID,
      }),
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { generationId: string };

    const row = await prisma.agentTemplateGeneration.findUnique({
      where: { id: body.generationId },
    });
    expect(row?.ownerAccountId).toBe(ADMIN_ACCOUNT_ID);
  });
});
