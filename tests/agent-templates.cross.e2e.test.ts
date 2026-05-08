/**
 * Cross-area end-to-end happy path test
 *
 * Covers VAL-CROSS-E2E-001:
 *   Builder → Create → Publish → Public list → Public hashed-slug GET
 *
 * Five sequential steps exercising M3 (generate), M2 (persist + publish),
 * and M2 (public reads). OpenRouter is mocked at the service-singleton seam
 * for deterministic content; PostHog is stubbed.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { __resetPostHogForTests } from "@/api/v2/agent-templates/services/posthog";
import {
  __resetGenerateTemplateForTests,
  DEFAULT_TEST_METRICS,
  type GeneratedTemplate,
} from "@/api/v2/agent-templates/services/templateGen";
import { ADMIN_ACCOUNT_ID } from "@/utils/prefixed-id";
import { prisma } from "@/utils/prisma";
import {
  createTemplate,
  getTemplate,
  hashedSlugFor,
  listTemplates,
  publishTemplate,
  startAgentTemplatesServer,
  validAgentAssetsApiKey,
} from "./agent-templates.cross.helpers";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TEST_PORT = 4024;

// ---------------------------------------------------------------------------
// Mock generateTemplate at the service-singleton seam
// ---------------------------------------------------------------------------

const generatedTemplate: GeneratedTemplate = {
  agentName: "Grocery Tracker",
  description: "A cheery grocery-sharing assistant",
  prompt: "You help people track and share grocery lists",
  category: "Productivity",
  emoji: "🛒",
  tools: ["Search"],
  connections: [],
};

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

const cleanupTemplates = () =>
  prisma.agentTemplate.deleteMany({
    where: {
      ownerAccountId: ADMIN_ACCOUNT_ID,
      slug: { startsWith: "cross-e2e-" },
    },
  });

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("Cross-area E2E: Generate → Create → Publish → List → Hashed-slug GET (VAL-CROSS-E2E-001)", () => {
  let baseURL: string;
  let closeServer: () => Promise<void>;

  beforeAll(async () => {
    process.env.AGENT_ASSETS_API_KEY = validAgentAssetsApiKey;
    __resetPostHogForTests(() => {}); // no-op PostHog
    mockGenerate();

    const server = await startAgentTemplatesServer(TEST_PORT);
    baseURL = server.baseURL;
    closeServer = server.close;
  });

  afterAll(async () => {
    __resetGenerateTemplateForTests(null);
    __resetPostHogForTests(null);
    await closeServer();
  });

  beforeEach(async () => {
    await cleanupTemplates();
  });

  test("full 5-step cross-milestone flow succeeds", async () => {
    // --- Step 1: Generate (M3) ---
    const generateResponse = await fetch(
      `${baseURL}/api/v2/agent-templates/generate`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Agent-API-Key": validAgentAssetsApiKey,
        },
        body: JSON.stringify({ idea: "a cheery brewing buddy" }),
      },
    );

    expect(generateResponse.status).toBe(200);
    const generated = (await generateResponse.json()) as GeneratedTemplate;

    // Verify generated template shape
    expect(typeof generated.agentName).toBe("string");
    expect(generated.agentName.length).toBeGreaterThan(0);
    expect(Array.isArray(generated.tools)).toBe(true);
    expect(Array.isArray(generated.connections)).toBe(true);
    expect(generated.connections).toHaveLength(0);

    // --- Step 2: Create (M2 writes) ---
    const { body: created, response: createResponse } = await createTemplate({
      baseURL,
      body: {
        agentName: generated.agentName,
        description: generated.description,
        prompt: generated.prompt,
        category: generated.category,
        emoji: generated.emoji,
        tools: generated.tools,
        slug: "cross-e2e-grocery-tracker",
      },
    });

    expect(createResponse.status).toBe(201);
    expect(created.object).toBe("agent_template");
    expect((created.id as string).startsWith("tmpl_")).toBe(true);
    expect(created.ownerAccountId).toBe(ADMIN_ACCOUNT_ID);
    expect(created.status).toBe("draft");
    expect(created.version).toBe(1);
    expect(created.firstPublishedAt).toBeNull();
    expect(typeof created.slug).toBe("string");
    expect(created.slug).toBeTruthy();

    const persistedId = created.id as string;
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
