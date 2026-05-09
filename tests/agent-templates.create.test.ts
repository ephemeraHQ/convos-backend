import type { Server } from "node:http";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import express from "express";
import { agentTemplatesRouter } from "@/api/v2/agent-templates/agent-templates.router";
import { jsonMiddleware } from "@/middleware/json";
import { noRouteMiddleware } from "@/middleware/noRoute";
import { pinoMiddleware } from "@/middleware/pino";
import { createJwtToken } from "@/utils/jwt";
import { ADMIN_ACCOUNT_ID } from "@/utils/constants";
import { prisma } from "@/utils/prisma";

type TemplateBody = Record<string, unknown>;

const OTHER_ACCOUNT_ID = "bbbbbbbb-cccc-4ddd-eeee-ffffffff0001";

const app = express();
app.use(pinoMiddleware);
app.use(jsonMiddleware);
app.use("/api/v2/agent-templates", agentTemplatesRouter);
app.use(noRouteMiddleware);

let server: Server;
const baseURL = "http://localhost:4014";

const isoTimestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const snakeCasePattern = /_/;

const cleanupTemplates = () =>
  prisma.agentTemplate.deleteMany({
    where: {
      ownerAccountId: ADMIN_ACCOUNT_ID,
      OR: [
        { slug: { startsWith: "create-test-" } },
        { agentName: { startsWith: "Create Test" } },
        { agentName: "Generate" },
      ],
    },
  });

const makeAuthHeaders = async () => ({
  "Content-Type": "application/json",
  "X-Convos-AuthToken": await createJwtToken({
    deviceId: "test-device-agent-templates-create",
    accountId: ADMIN_ACCOUNT_ID,
  }),
});

const createTemplate = async (body: Record<string, unknown>) => {
  const response = await fetch(`${baseURL}/api/v2/agent-templates`, {
    method: "POST",
    headers: await makeAuthHeaders(),
    body: JSON.stringify(body),
  });
  const parsedBody = (await response.json()) as TemplateBody;

  return { body: parsedBody, response };
};

const expectTemplateShape = (body: TemplateBody) => {
  expect(body.object).toBe("agent_template");
  expect(body.id).toEqual(
    expect.stringMatching(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    ),
  );
  expect(body.ownerAccountId).toBe(ADMIN_ACCOUNT_ID);
  expect(body.status).toBe("draft");
  expect(body.version).toBe(1);
  expect(body.firstPublishedAt).toBeNull();
  expect(body.forkedFromId).toBeNull();
  expect(body.createdAt).toEqual(expect.stringMatching(isoTimestampPattern));
  expect(body).not.toHaveProperty("updatedAt");
  expect(Object.keys(body).every((key) => !snakeCasePattern.test(key))).toBe(
    true,
  );
};

const countCreateTestTemplates = () =>
  prisma.agentTemplate.count({
    where: {
      ownerAccountId: ADMIN_ACCOUNT_ID,
      OR: [
        { slug: { startsWith: "create-test-" } },
        { agentName: { startsWith: "Create Test" } },
        { agentName: "Generate" },
      ],
    },
  });

describe("Agent template create endpoint", () => {
  beforeAll(async () => {
    await new Promise<void>((resolve) => {
      server = app.listen(4014, () => {
        resolve();
      });
    });
  });

  afterAll(async () => {
    await cleanupTemplates();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  });

  beforeEach(async () => {
    await cleanupTemplates();
  });

  test("requires auth and creates a template with explicit slug and camelCase pinned defaults", async () => {
    const unauthenticated = await fetch(`${baseURL}/api/v2/agent-templates`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agentName: "Create Test No Auth",
        prompt: "You are helpful",
        slug: "create-test-no-auth",
      }),
    });
    expect(unauthenticated.status).toBe(401);

    const { body, response } = await createTemplate({
      agentName: "Create Test Helper",
      prompt: "You are helpful",
      slug: "create-test-helper-bot",
    });

    expect(response.status).toBe(201);
    expect(response.headers.get("content-type")).toContain("application/json");
    expectTemplateShape(body);
    expect(body).toMatchObject({
      slug: "create-test-helper-bot",
      agentName: "Create Test Helper",
      prompt: "You are helpful",
      description: null,
      category: null,
      emoji: null,
      avatarUrl: null,
      tools: [],
      connections: [],
      featured: false,
    });
    expect(body).not.toHaveProperty("owner_account_id");
    expect(body).not.toHaveProperty("first_published_at");
  });

  test("ignores server-pinned fields from the body and persists pinned values", async () => {
    const { body, response } = await createTemplate({
      agentName: "Create Test Sneaky",
      prompt: "You are still a draft",
      slug: "create-test-sneaky",
      ownerAccountId: OTHER_ACCOUNT_ID,
      status: "published",
      version: 99,
      firstPublishedAt: "2020-01-01T00:00:00.000Z",
      forkedFromId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    });

    expect(response.status).toBe(201);
    expectTemplateShape(body);

    const row = await prisma.agentTemplate.findUniqueOrThrow({
      where: { id: body.id as string },
    });
    expect(row.ownerAccountId).toBe(ADMIN_ACCOUNT_ID);
    expect(row.status).toBe("draft");
    expect(row.version).toBe(1);
    expect(row.firstPublishedAt).toBeNull();
    expect(row.forkedFromId).toBeNull();
  });

  test("auto-derives slugs and retries collisions with numeric suffixes", async () => {
    const slugs: string[] = [];

    for (let i = 0; i < 3; i++) {
      const { body, response } = await createTemplate({
        agentName: "Create Test My Cool Helper",
        prompt: `Prompt ${i}`,
      });

      expect(response.status).toBe(201);
      expect(typeof body.slug).toBe("string");
      slugs.push(body.slug as string);
    }

    expect(slugs).toEqual([
      "create-test-my-cool-helper",
      "create-test-my-cool-helper-2",
      "create-test-my-cool-helper-3",
    ]);

    const rows = await prisma.agentTemplate.findMany({
      where: {
        ownerAccountId: ADMIN_ACCOUNT_ID,
        slug: { in: slugs },
      },
      orderBy: { createdAt: "asc" },
      select: { slug: true },
    });
    expect(rows.map((row) => row.slug)).toEqual(slugs);
  });

  test("rejects auto-derived reserved slugs with 400 and rejects reserved explicit slugs", async () => {
    // Auto-derived slug from agentName='Generate' → baseSlug='generate' (reserved)
    // Server MUST reject with 400 RESERVED_SLUG, NOT silently suffix to 'generate-2'
    const autoReserved = await createTemplate({
      agentName: "Generate",
      prompt: "Should be rejected because auto-derived slug is reserved",
    });
    expect(autoReserved.response.status).toBe(400);
    expect(autoReserved.body.error).toMatchObject({ code: "RESERVED_SLUG" });

    // All seven reserved words as auto-derived slugs must be rejected
    for (const word of [
      "generate",
      "publish",
      "fork",
      "search",
      "files",
      "templates",
      "skills",
    ]) {
      const agentName = word[0].toUpperCase() + word.slice(1);
      const { body, response } = await createTemplate({
        agentName,
        prompt: "Should be rejected because auto-derived slug is reserved",
      });

      expect(response.status).toBe(400);
      expect(body.error).toMatchObject({ code: "RESERVED_SLUG" });
    }

    // Explicit reserved slugs are also rejected
    for (const slug of [
      "generate",
      "publish",
      "fork",
      "search",
      "files",
      "templates",
      "skills",
    ]) {
      const { body, response } = await createTemplate({
        agentName: `Create Test Reserved ${slug}`,
        prompt: "Should be rejected",
        slug,
      });

      expect(response.status).toBe(400);
      expect(body.error).toMatchObject({ code: "RESERVED_SLUG" });
    }

    // No rows created for any reserved-slug attempt
    expect(await countCreateTestTemplates()).toBe(0);
  });

  test("rejects invalid user-supplied slugs and preserves row count", async () => {
    const startingCount = await countCreateTestTemplates();

    for (const slug of [
      "Has-Caps",
      "-leading-hyphen",
      "trailing-dot.",
      "with space",
      "",
      "a".repeat(65),
    ]) {
      const { body, response } = await createTemplate({
        agentName: `Create Test Invalid ${slug || "empty"}`,
        prompt: "Should be rejected",
        slug,
      });

      expect(response.status).toBe(400);
      expect(body.error).toBeDefined();
      expect(await countCreateTestTemplates()).toBe(startingCount);
    }
  });

  test("returns 409 for same-owner slug conflicts", async () => {
    const first = await createTemplate({
      agentName: "Create Test Taken A",
      prompt: "First",
      slug: "create-test-taken",
    });
    expect(first.response.status).toBe(201);

    const second = await createTemplate({
      agentName: "Create Test Taken B",
      prompt: "Second",
      slug: "create-test-taken",
    });
    expect(second.response.status).toBe(409);
    expect(second.body.error).toMatchObject({ code: "SLUG_CONFLICT" });

    const rows = await prisma.agentTemplate.count({
      where: { ownerAccountId: ADMIN_ACCOUNT_ID, slug: "create-test-taken" },
    });
    expect(rows).toBe(1);
  });

  test("rejects missing or empty agentName and prompt", async () => {
    for (const body of [
      { prompt: "Missing agentName", slug: "create-test-missing-name" },
      {
        agentName: "Create Test Missing Prompt",
        slug: "create-test-no-prompt",
      },
      {
        agentName: "",
        prompt: "Empty agentName",
        slug: "create-test-empty-name",
      },
      {
        agentName: "Create Test Empty Prompt",
        prompt: "",
        slug: "create-test-empty-prompt",
      },
    ]) {
      const result = await createTemplate(body);

      expect(result.response.status).toBe(400);
      expect(result.body.error).toBe("Invalid request body");
    }

    expect(await countCreateTestTemplates()).toBe(0);
  });

  test("defaults optional fields and durably persists the created row", async () => {
    const { body, response } = await createTemplate({
      agentName: "Create Test Minimal",
      prompt: "Persist me",
    });

    expect(response.status).toBe(201);
    expect(body).toMatchObject({
      description: null,
      category: null,
      emoji: null,
      avatarUrl: null,
      tools: [],
      connections: [],
      featured: false,
      forkedFromId: null,
    });

    const row = await prisma.agentTemplate.findUniqueOrThrow({
      where: { id: body.id as string },
    });
    expect(row.slug).toBe("create-test-minimal");
    expect(row.agentName).toBe("Create Test Minimal");
    expect(row.prompt).toBe("Persist me");
    expect(row.ownerAccountId).toBe(ADMIN_ACCOUNT_ID);
    expect(row.status).toBe("draft");
    expect(row.version).toBe(1);
    expect(row.firstPublishedAt).toBeNull();
    expect(row.description).toBeNull();
    expect(row.category).toBeNull();
    expect(row.emoji).toBeNull();
    expect(row.avatarUrl).toBeNull();
    expect(row.tools).toEqual([]);
    expect(row.connections).toEqual([]);
    expect(row.featured).toBe(false);
  });

  test("accepts tools and connections arrays of strings and rejects non-array values", async () => {
    const { body, response } = await createTemplate({
      agentName: "Create Test Integrations",
      prompt: "Use tools",
      slug: "create-test-integrations",
      tools: ["web_search", "calc"],
      connections: ["composio:google_calendar", "apple_health"],
    });

    expect(response.status).toBe(201);
    expect(body.tools).toEqual(["web_search", "calc"]);
    expect(body.connections).toEqual([
      "composio:google_calendar",
      "apple_health",
    ]);

    for (const invalidBody of [
      {
        agentName: "Create Test Invalid Tools",
        prompt: "Invalid tools",
        slug: "create-test-invalid-tools",
        tools: "web_search",
      },
      {
        agentName: "Create Test Invalid Connections",
        prompt: "Invalid connections",
        slug: "create-test-invalid-connections",
        connections: "apple_health",
      },
    ]) {
      const result = await createTemplate(invalidBody);

      expect(result.response.status).toBe(400);
      expect(result.body.error).toBe("Invalid request body");
    }
  });
});
