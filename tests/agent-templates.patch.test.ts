import type { Server } from "node:http";
import type { Prisma } from "@prisma/client";
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
import { prisma } from "@/utils/prisma";

type TemplateBody = Record<string, unknown>;

const app = express();
app.use(pinoMiddleware);
app.use(jsonMiddleware);
app.use("/api/v2/agent-templates", agentTemplatesRouter);
app.use(noRouteMiddleware);

let server: Server;
const baseURL = "http://localhost:4017";
const publishedAt = new Date("2026-02-01T12:00:00.000Z");
const createdAt = new Date("2026-01-31T12:00:00.000Z");
const isoTimestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

const cleanupTemplates = () =>
  prisma.agentTemplate.deleteMany({
    where: { id: { startsWith: "tmpl_test_patch_" } },
  });

const makeAuthHeaders = async () => ({
  "Content-Type": "application/json",
  "X-Convos-AuthToken": await createJwtToken({
    deviceId: "test-device-agent-templates-patch",
  }),
});

const seedTemplate = async (
  overrides: Partial<Prisma.AgentTemplateUncheckedCreateInput> & {
    id: string;
  },
) => {
  const status = overrides.status ?? "draft";
  const defaultFirstPublishedAt =
    status === "draft" ? null : new Date(publishedAt);

  return prisma.agentTemplate.create({
    data: {
      id: overrides.id,
      slug: overrides.slug ?? overrides.id.replace(/_/g, "-"),
      ownerAccountId: overrides.ownerAccountId ?? "acct_admin",
      forkedFromId: overrides.forkedFromId ?? null,
      agentName: overrides.agentName ?? "Patch Test Template",
      description: overrides.description ?? null,
      prompt: overrides.prompt ?? "Initial prompt",
      category: overrides.category ?? null,
      emoji: overrides.emoji ?? null,
      avatarUrl: overrides.avatarUrl ?? null,
      tools: overrides.tools ?? [],
      connections: overrides.connections ?? [],
      version: overrides.version ?? 1,
      firstPublishedAt:
        overrides.firstPublishedAt === undefined
          ? defaultFirstPublishedAt
          : overrides.firstPublishedAt,
      status,
      featured: overrides.featured ?? false,
      createdAt: overrides.createdAt ?? createdAt,
    },
  });
};

const patchTemplate = async (id: string, body: Record<string, unknown>) => {
  const response = await fetch(`${baseURL}/api/v2/agent-templates/${id}`, {
    method: "PATCH",
    headers: await makeAuthHeaders(),
    body: JSON.stringify(body),
  });
  const parsedBody = (await response.json()) as TemplateBody;

  return { body: parsedBody, response };
};

const expectTemplateShape = (body: TemplateBody) => {
  expect(Object.keys(body).sort()).toEqual([
    "agentName",
    "avatarUrl",
    "category",
    "connections",
    "createdAt",
    "description",
    "emoji",
    "featured",
    "firstPublishedAt",
    "forkedFromId",
    "id",
    "object",
    "ownerAccountId",
    "prompt",
    "slug",
    "status",
    "tools",
    "version",
  ]);
  expect(body.object).toBe("agent_template");
  expect(body.createdAt).toEqual(expect.stringMatching(isoTimestampPattern));
  expect(body).not.toHaveProperty("updatedAt");
};

describe("Agent template patch endpoint", () => {
  beforeAll(async () => {
    await new Promise<void>((resolve) => {
      server = app.listen(4017, () => {
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

  test("returns 404 for an unknown template id", async () => {
    const { body, response } = await patchTemplate("tmpl_test_patch_missing", {
      description: "x",
    });

    expect(response.status).toBe(404);
    expect(body.error).toBeDefined();
  });

  test("updates content fields immediately without bumping version or firstPublishedAt", async () => {
    const template = await seedTemplate({
      id: "tmpl_test_patch_content",
      slug: "patch-test-content",
      status: "published",
      firstPublishedAt: publishedAt,
      version: 7,
    });

    const { body, response } = await patchTemplate(template.id, {
      prompt: "New prompt",
      tools: ["web_search", "calculator"],
      connections: ["calendar", "gmail"],
      avatarUrl: "https://example.com/avatar.png",
      agentName: "Renamed Patch Test",
      description: "Updated description",
      category: "productivity",
      emoji: "🤖",
    });

    expect(response.status).toBe(200);
    expectTemplateShape(body);
    expect(body).toMatchObject({
      prompt: "New prompt",
      tools: ["web_search", "calculator"],
      connections: ["calendar", "gmail"],
      avatarUrl: "https://example.com/avatar.png",
      agentName: "Renamed Patch Test",
      description: "Updated description",
      category: "productivity",
      emoji: "🤖",
      version: 7,
      firstPublishedAt: publishedAt.toISOString(),
    });

    const row = await prisma.agentTemplate.findUniqueOrThrow({
      where: { id: template.id },
    });
    expect(row.version).toBe(7);
    expect(row.firstPublishedAt?.toISOString()).toBe(publishedAt.toISOString());
    expect(row.prompt).toBe("New prompt");
    expect(row.agentName).toBe("Renamed Patch Test");
    expect(row.tools).toEqual(["web_search", "calculator"]);
    expect(row.connections).toEqual(["calendar", "gmail"]);
  });

  test("allows valid pre-publish slug patches and enforces the 64 character boundary", async () => {
    const template = await seedTemplate({
      id: "tmpl_test_patch_slug",
      slug: "patch-test-old",
    });
    const maxLengthSlug = "a".repeat(64);

    const renamed = await patchTemplate(template.id, {
      slug: "patch-test-new",
    });
    expect(renamed.response.status).toBe(200);
    expect(renamed.body.slug).toBe("patch-test-new");

    const tooLong = await patchTemplate(template.id, { slug: "a".repeat(65) });
    expect(tooLong.response.status).toBe(400);
    expect(
      await prisma.agentTemplate.findUniqueOrThrow({
        where: { id: template.id },
      }),
    ).toMatchObject({ slug: "patch-test-new" });

    const boundary = await patchTemplate(template.id, { slug: maxLengthSlug });
    expect(boundary.response.status).toBe(200);
    expect(boundary.body.slug).toBe(maxLengthSlug);
    expect(
      await prisma.agentTemplate.findUniqueOrThrow({
        where: { id: template.id },
      }),
    ).toMatchObject({ slug: maxLengthSlug });
  });

  test("validates draft slug patches and leaves the row unchanged on invalid or conflicting slugs", async () => {
    await seedTemplate({
      id: "tmpl_test_patch_slug_taken",
      slug: "patch-test-taken",
    });
    const template = await seedTemplate({
      id: "tmpl_test_patch_slug_invalid",
      slug: "patch-test-original",
    });

    for (const slug of ["Has-Caps", "with space", "", "generate"]) {
      const result = await patchTemplate(template.id, { slug });
      expect(result.response.status).toBe(400);
      expect(
        await prisma.agentTemplate.findUniqueOrThrow({
          where: { id: template.id },
        }),
      ).toMatchObject({ slug: "patch-test-original" });
    }

    const conflict = await patchTemplate(template.id, {
      slug: "patch-test-taken",
    });
    expect(conflict.response.status).toBe(409);
    expect(
      await prisma.agentTemplate.findUniqueOrThrow({
        where: { id: template.id },
      }),
    ).toMatchObject({ slug: "patch-test-original" });
  });

  test("rejects slug changes after first publish and preserves the existing slug", async () => {
    const template = await seedTemplate({
      id: "tmpl_test_patch_slug_immutable",
      slug: "patch-test-immutable",
      status: "published",
      firstPublishedAt: publishedAt,
    });

    const result = await patchTemplate(template.id, {
      slug: "patch-test-moved",
    });

    expect(result.response.status).toBe(400);
    expect(
      await prisma.agentTemplate.findUniqueOrThrow({
        where: { id: template.id },
      }),
    ).toMatchObject({ slug: "patch-test-immutable" });
  });

  test("applies the allowed post-publish status transition matrix", async () => {
    const published = await seedTemplate({
      id: "tmpl_test_patch_status_published",
      slug: "patch-test-status-published",
      status: "published",
    });

    const toUnlisted = await patchTemplate(published.id, {
      status: "unlisted",
    });
    expect(toUnlisted.response.status).toBe(200);
    expect(toUnlisted.body.status).toBe("unlisted");

    const backToPublished = await patchTemplate(published.id, {
      status: "published",
    });
    expect(backToPublished.response.status).toBe(200);
    expect(backToPublished.body.status).toBe("published");

    const publishedToArchived = await patchTemplate(published.id, {
      status: "archived",
    });
    expect(publishedToArchived.response.status).toBe(200);
    expect(publishedToArchived.body.status).toBe("archived");

    const unlisted = await seedTemplate({
      id: "tmpl_test_patch_status_unlisted",
      slug: "patch-test-status-unlisted",
      status: "unlisted",
    });
    const unlistedToArchived = await patchTemplate(unlisted.id, {
      status: "archived",
    });
    expect(unlistedToArchived.response.status).toBe(200);
    expect(unlistedToArchived.body.status).toBe("archived");

    const archivedToPublished = await patchTemplate(unlisted.id, {
      status: "published",
    });
    expect(archivedToPublished.response.status).toBe(200);
    expect(archivedToPublished.body.status).toBe("published");

    const archived = await seedTemplate({
      id: "tmpl_test_patch_status_archived",
      slug: "patch-test-status-archived",
      status: "archived",
    });
    const archivedToUnlisted = await patchTemplate(archived.id, {
      status: "unlisted",
    });
    expect(archivedToUnlisted.response.status).toBe(200);
    expect(archivedToUnlisted.body.status).toBe("unlisted");
  });

  test("rejects status transitions into draft after publish and out of draft via PATCH", async () => {
    for (const status of ["published", "unlisted", "archived"] as const) {
      const template = await seedTemplate({
        id: `tmpl_test_patch_to_draft_${status}`,
        slug: `patch-test-to-draft-${status}`,
        status,
      });

      const result = await patchTemplate(template.id, { status: "draft" });
      expect(result.response.status).toBe(400);
      expect(
        await prisma.agentTemplate.findUniqueOrThrow({
          where: { id: template.id },
        }),
      ).toMatchObject({ status });
    }

    for (const target of ["published", "unlisted", "archived"] as const) {
      const template = await seedTemplate({
        id: `tmpl_test_patch_from_draft_${target}`,
        slug: `patch-test-from-draft-${target}`,
        status: "draft",
        firstPublishedAt: null,
      });

      const result = await patchTemplate(template.id, { status: target });
      expect(result.response.status).toBe(400);
      expect(
        await prisma.agentTemplate.findUniqueOrThrow({
          where: { id: template.id },
        }),
      ).toMatchObject({ status: "draft", firstPublishedAt: null });
    }
  });

  test("ignores server-pinned fields and keeps the database row unchanged", async () => {
    const template = await seedTemplate({
      id: "tmpl_test_patch_pinned",
      slug: "patch-test-pinned",
      status: "published",
      firstPublishedAt: publishedAt,
      version: 3,
      createdAt,
    });

    const result = await patchTemplate(template.id, {
      ownerAccountId: "acct_other",
      version: 42,
      firstPublishedAt: "2020-01-01T00:00:00.000Z",
      forkedFromId: "tmpl_test_patch_other",
      createdAt: "2000-01-01T00:00:00.000Z",
      id: "tmpl_test_patch_other",
    });

    expect(result.response.status).toBe(200);
    expect(result.body).toMatchObject({
      id: template.id,
      ownerAccountId: "acct_admin",
      version: 3,
      firstPublishedAt: publishedAt.toISOString(),
      forkedFromId: null,
      createdAt: createdAt.toISOString(),
    });

    const row = await prisma.agentTemplate.findUniqueOrThrow({
      where: { id: template.id },
    });
    expect(row.ownerAccountId).toBe("acct_admin");
    expect(row.version).toBe(3);
    expect(row.firstPublishedAt?.toISOString()).toBe(publishedAt.toISOString());
    expect(row.forkedFromId).toBeNull();
    expect(row.createdAt.toISOString()).toBe(createdAt.toISOString());
    expect(
      await prisma.agentTemplate.findUnique({
        where: { id: "tmpl_test_patch_other" },
      }),
    ).toBeNull();
  });

  test("returns the full template object and preserves it on an empty body no-op", async () => {
    const template = await seedTemplate({
      id: "tmpl_test_patch_empty",
      slug: "patch-test-empty",
      status: "published",
      firstPublishedAt: publishedAt,
    });

    const first = await patchTemplate(template.id, {});
    expect(first.response.status).toBe(200);
    expectTemplateShape(first.body);
    expect(first.body.firstPublishedAt).toEqual(
      expect.stringMatching(isoTimestampPattern),
    );

    const second = await patchTemplate(template.id, {});
    expect(second.response.status).toBe(200);
    expect(second.body).toEqual(first.body);
  });
});
