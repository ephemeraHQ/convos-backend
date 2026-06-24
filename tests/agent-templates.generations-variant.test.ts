/**
 * Tests for the agent-variant builder-prompt seam in POST /generations.
 *
 * A `variantId` selects a registered variant; when it pins a bench builder-
 * prompt slug, the backend resolves that slug to text (here via the bench-loader
 * test override) and persists it as the generation row's `builderPrompt`. A
 * variant with no slug, or an unknown variantId, degrades to the canonical
 * generator (builderPrompt stays null). XMTP_ENV is "local" under tests/setup,
 * so the dev-gate is open.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { __resetBenchPromptLoaderForTests } from "@/api/v2/agent-templates/services/bench-prompt";
import { __resetGenerationExecutorForTests } from "@/api/v2/agent-templates/services/generation-executor";
import { __resetModerationForTests } from "@/api/v2/agent-templates/services/moderation";
import { __setOpenRouterModelsForTests } from "@/api/v2/agent-templates/services/openrouter-models";
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

const TEST_PORT = 4078;
const TEST_SOURCE = "generations-variant-test";
const SLUG_PREFIX = "pr-test-variant-gen-";
const VARIANT_WITH_PROMPT = `${SLUG_PREFIX}axisb`;
const VARIANT_RUNTIME_ONLY = `${SLUG_PREFIX}axisa`;
const BENCH_SLUG = "qa-flow-v2";

const fakeTemplate = makeFakeTemplate({
  agentName: "Variant Test Agent",
  description: "desc",
  prompt: "prompt",
});

const headers = (key: string) => ({
  "Content-Type": "application/json",
  "X-Agent-API-Key": validAgentAssetsApiKey,
  "Idempotency-Key": stableUuid(key),
});

let baseURL: string;
let closeServer: () => Promise<void>;

const post = (body: unknown, key: string) =>
  fetch(`${baseURL}/api/v2/agent-templates/generations`, {
    method: "POST",
    headers: headers(key),
    body: JSON.stringify(body),
  });

// The handler's create() omits builderPrompt from its select, so read it back
// off the persisted row.
async function latestBuilderPrompt(): Promise<string | null> {
  const row = await prisma.agentTemplateGeneration.findFirst({
    where: { ownerAccountId: ADMIN_ACCOUNT_ID, source: TEST_SOURCE },
    select: { builderPrompt: true },
    orderBy: { createdAt: "desc" },
  });
  return row?.builderPrompt ?? null;
}

async function cleanupGenerations() {
  await prisma.agentTemplateGeneration.deleteMany({
    where: { ownerAccountId: ADMIN_ACCOUNT_ID, source: TEST_SOURCE },
  });
}

beforeAll(async () => {
  __setAgentAssetsApiKeyOverrideForTests(validAgentAssetsApiKey);
  __resetPostHogForTests(() => {});
  __resetModerationForTests(() => Promise.resolve({ allowed: true }));
  __setOpenRouterModelsForTests(["anthropic/claude-opus-4.8"]);
  __resetGenerateTemplateForTests(() =>
    Promise.resolve({ template: fakeTemplate, metrics: DEFAULT_TEST_METRICS }),
  );
  // Echo the bench slug so a test can assert which slug was resolved, without
  // hitting Braintrust.
  __resetBenchPromptLoaderForTests((slug) =>
    Promise.resolve(`BUILDER PROMPT for ${slug}`),
  );

  await prisma.agentVariant.deleteMany({
    where: { slug: { startsWith: SLUG_PREFIX } },
  });
  await prisma.agentVariant.createMany({
    data: [
      {
        slug: VARIANT_WITH_PROMPT,
        label: "Q+A",
        whatToTest: "asks first",
        status: "ready",
        assistantWorkerUrl: `https://ephemeral-${VARIANT_WITH_PROMPT}.convos.fun`,
        builderPromptSlug: BENCH_SLUG,
        prUrl: "https://github.com/x/y/pull/1",
        branch: "b",
        commit: "c",
      },
      {
        slug: VARIANT_RUNTIME_ONLY,
        label: "Runtime",
        whatToTest: "runtime only",
        status: "ready",
        assistantWorkerUrl: `https://ephemeral-${VARIANT_RUNTIME_ONLY}.convos.fun`,
        builderPromptSlug: null,
        prUrl: "https://github.com/x/y/pull/2",
        branch: "b",
        commit: "c",
      },
    ],
  });

  const server = await startAgentTemplatesServer(TEST_PORT);
  baseURL = server.baseURL;
  closeServer = server.close;
});

afterEach(async () => {
  __resetGenerationExecutorForTests(null);
  await cleanupGenerations();
});

afterAll(async () => {
  __resetBenchPromptLoaderForTests(null);
  __resetGenerateTemplateForTests(null);
  __resetPostHogForTests(null);
  __resetModerationForTests(null);
  __setOpenRouterModelsForTests(null);
  __setAgentAssetsApiKeyOverrideForTests(undefined);
  await prisma.agentVariant.deleteMany({
    where: { slug: { startsWith: SLUG_PREFIX } },
  });
  await closeServer();
});

describe("POST /generations — agent variant builder prompt", () => {
  test("a variant pinning a bench slug resolves into builderPrompt", async () => {
    const res = await post(
      {
        source: TEST_SOURCE,
        inputs: { text: "build me a trivia bot" },
        variantId: VARIANT_WITH_PROMPT,
      },
      "variant-resolves",
    );
    expect([200, 202]).toContain(res.status);
    expect(await latestBuilderPrompt()).toBe(
      `BUILDER PROMPT for ${BENCH_SLUG}`,
    );
  });

  test("a runtime-only variant (no slug) leaves builderPrompt null (canonical)", async () => {
    const res = await post(
      {
        source: TEST_SOURCE,
        inputs: { text: "build me a trivia bot" },
        variantId: VARIANT_RUNTIME_ONLY,
      },
      "variant-runtime-only",
    );
    expect([200, 202]).toContain(res.status);
    expect(await latestBuilderPrompt()).toBeNull();
  });

  test("an unknown variantId degrades to the canonical generator", async () => {
    const res = await post(
      {
        source: TEST_SOURCE,
        inputs: { text: "build me a trivia bot" },
        variantId: `${SLUG_PREFIX}does-not-exist`,
      },
      "variant-unknown",
    );
    expect([200, 202]).toContain(res.status);
    expect(await latestBuilderPrompt()).toBeNull();
  });
});
