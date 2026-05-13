/**
 * Cross-area end-to-end happy path test
 *
 * *   Generate (async) → Read draft → Publish → Public list → Public hashed-slug GET
 *
 * Sequential steps exercising the async generation pipeline (POST /generations
 * with wait_ms long-poll), the existing CRUD surface (publish), and public
 * reads. OpenRouter and content moderation are mocked at the service-singleton
 * seams for deterministic behaviour; PostHog is stubbed.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { __resetGenerationExecutorForTests } from "@/api/v2/agent-templates/services/generation-executor";
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
  getTemplate,
  hashedSlugFor,
  listTemplates,
  publishTemplate,
  startAgentTemplatesServer,
  validAgentAssetsApiKey,
} from "./agent-templates.cross.helpers";
import { makeFakeTemplate } from "./agent-templates.generation.helpers";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TEST_PORT = 4074;

// ---------------------------------------------------------------------------
// Mock generateTemplate at the service-singleton seam
// ---------------------------------------------------------------------------

const generatedTemplate = makeFakeTemplate({
  agentName: "Grocery Tracker",
  description: "A cheery grocery-sharing assistant",
  prompt: "You help people track and share grocery lists",
  category: "Productivity",
  emoji: "🛒",
  tools: ["Search"],
});

const mockGenerate = () => {
  __resetGenerateTemplateForTests(() =>
    Promise.resolve({
      template: generatedTemplate,
      metrics: DEFAULT_TEST_METRICS,
    }),
  );
};

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

const cleanupTemplates = async () => {
  // Generations FK to templates; clear generations first.
  await prisma.agentTemplateGeneration.deleteMany({
    where: { ownerAccountId: ADMIN_ACCOUNT_ID, source: "cross-e2e" },
  });
  await prisma.agentTemplate.deleteMany({
    where: {
      ownerAccountId: ADMIN_ACCOUNT_ID,
      agentName: generatedTemplate.agentName,
    },
  });
};

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("Cross-area E2E: Generate → Create → Publish → List → Hashed-slug GET", () => {
  let baseURL: string;
  let closeServer: () => Promise<void>;

  beforeAll(async () => {
    __setAgentAssetsApiKeyOverrideForTests(validAgentAssetsApiKey);
    __resetPostHogForTests(() => {}); // no-op PostHog
    __resetModerationForTests(() => Promise.resolve({ allowed: true }));
    mockGenerate();

    const server = await startAgentTemplatesServer(TEST_PORT);
    baseURL = server.baseURL;
    closeServer = server.close;
  });

  afterAll(async () => {
    __resetGenerateTemplateForTests(null);
    __resetGenerationExecutorForTests(null);
    __resetModerationForTests(null);
    __resetPostHogForTests(null);
    await closeServer();
  });

  beforeEach(async () => {
    await cleanupTemplates();
  });

  test("full cross-milestone flow succeeds", async () => {
    // --- Step 1: Generate (async POST /generations with wait_ms inline poll) ---
    const generateResponse = await fetch(
      `${baseURL}/api/v2/agent-templates/generations?wait_ms=10000`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Agent-API-Key": validAgentAssetsApiKey,
          "Idempotency-Key": "cross-e2e-step1",
        },
        body: JSON.stringify({
          source: "cross-e2e",
          inputs: { idea: "a cheery brewing buddy" },
        }),
      },
    );

    expect(generateResponse.status).toBe(200);
    const genBody = (await generateResponse.json()) as {
      generationId: string;
      status: string;
      templateId?: string;
      error?: string;
    };
    expect(genBody.status).toBe("done");
    expect(typeof genBody.templateId).toBe("string");
    expect(genBody.templateId).toBeTruthy();

    const persistedId = genBody.templateId as string;

    // --- Step 2: Read the persisted draft template (M2 read) ---
    const { body: created, response: createResponse } = await getTemplate({
      baseURL,
      path: persistedId,
      headers: { "X-Agent-API-Key": validAgentAssetsApiKey },
    });

    expect(createResponse.status).toBe(200);
    expect(created.object).toBe("agent_template");
    expect(created.id).toBe(persistedId);
    expect(created.ownerAccountId).toBe(ADMIN_ACCOUNT_ID);
    expect(created.status).toBe("draft");
    expect(created.version).toBe(1);
    expect(created.firstPublishedAt).toBeNull();
    expect(typeof created.slug).toBe("string");
    expect(created.slug).toBeTruthy();
    expect(created.agentName).toBe(generatedTemplate.agentName);
    expect(Array.isArray(created.tools)).toBe(true);
    expect(Array.isArray(created.connections)).toBe(true);
    expect(created.connections).toHaveLength(0);

    const persistedSlug = created.slug as string;

    // --- Step 3: Publish (M2 publish) ---
    const { body: published, response: publishResponse } =
      await publishTemplate({
        baseURL,
        id: persistedId,
      });

    expect(publishResponse.status).toBe(200);
    expect(published.status).toBe("published");
    expect(published.version).toBe(1); // unchanged on first publish
    expect(published.firstPublishedAt).not.toBeNull();
    // ISO-8601 Z suffix
    expect((published.firstPublishedAt as string).endsWith("Z")).toBe(true);
    expect(published.id).toBe(persistedId);
    expect(published.slug).toBe(persistedSlug);

    // --- Step 4: Public list (M2 reads, no auth) ---
    const { body: listBody, response: listResponse } = await listTemplates({
      baseURL,
      query: "?limit=100",
    });

    expect(listResponse.status).toBe(200);
    expect(listBody.data).toBeDefined();
    expect(Array.isArray(listBody.data)).toBe(true);

    // The published template must appear in the list
    const listIds = listBody.data.map((row) => row.id as string);
    expect(listIds).toContain(persistedId);

    // --- Step 5: Public hashed-slug GET (M2 reads, no auth) ---
    const hashedSlug = hashedSlugFor({
      id: persistedId,
      slug: persistedSlug,
    });
    const { body: detailBody, response: detailResponse } = await getTemplate({
      baseURL,
      path: hashedSlug,
    });

    expect(detailResponse.status).toBe(200);
    expect(detailBody.id).toBe(persistedId);
    expect(detailBody.status).toBe("published");
    expect(detailBody.slug).toBe(persistedSlug);

    // Cleanup
    await cleanupTemplates();
  });
});
