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
import { ADMIN_ACCOUNT_ID } from "@/utils/prefixed-id";
import { prisma } from "@/utils/prisma";

type TemplateBody = Record<string, unknown>;

const app = express();
app.use(pinoMiddleware);
app.use(jsonMiddleware);
app.use("/api/v2/agent-templates", agentTemplatesRouter);
app.use(noRouteMiddleware);

let server: Server;
const baseURL = "http://localhost:4018";
const publishedAt = new Date("2026-02-01T12:00:00.000Z");
const createdAt = new Date("2026-01-31T12:00:00.000Z");

const cleanupTemplates = () =>
  prisma.agentTemplate.deleteMany({
    where: {
      ownerAccountId: ADMIN_ACCOUNT_ID,
      OR: [
        { id: { startsWith: "tmpl_test_delete_" } },
        { slug: { startsWith: "delete-test-" } },
        { agentName: { startsWith: "Delete Test" } },
      ],
    },
  });

const makeAuthHeaders = async () => ({
  "Content-Type": "application/json",
  "X-Convos-AuthToken": await createJwtToken({
    deviceId: "test-device-agent-templates-delete",
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
      ownerAccountId: overrides.ownerAccountId ?? ADMIN_ACCOUNT_ID,
      forkedFromId: overrides.forkedFromId ?? null,
      agentName: overrides.agentName ?? "Delete Test Template",
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

const deleteTemplate = async (id: string) => {
  const response = await fetch(`${baseURL}/api/v2/agent-templates/${id}`, {
    method: "DELETE",
    headers: await makeAuthHeaders(),
  });
  const body = (await response.json()) as TemplateBody;

  return { body, response };
};

const createTemplate = async (body: Record<string, unknown>) => {
  const response = await fetch(`${baseURL}/api/v2/agent-templates`, {
    method: "POST",
    headers: await makeAuthHeaders(),
    body: JSON.stringify(body),
  });
  const parsedBody = (await response.json()) as TemplateBody;

  return { body: parsedBody, response };
};

describe("Agent template delete endpoint", () => {
  beforeAll(async () => {
    await new Promise<void>((resolve) => {
      server = app.listen(4018, () => {
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
    const { body, response } = await deleteTemplate("tmpl_test_delete_missing");

    expect(response.status).toBe(404);
    expect(body.error).toBeDefined();
  });

  test("hard-deletes a draft and returns the exact JSON tombstone shape", async () => {
    const template = await seedTemplate({
      id: "tmpl_test_delete_draft",
      slug: "delete-test-draft",
    });

    const { body, response } = await deleteTemplate(template.id);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(Object.keys(body).sort()).toEqual(["deleted", "id", "object"]);
    expect(body).toEqual({
      object: "agent_template",
      id: template.id,
      deleted: true,
    });
    expect(
      await prisma.agentTemplate.count({ where: { id: template.id } }),
    ).toBe(0);
  });

  test("rejects deleting a published row with ALREADY_PUBLISHED and preserves it", async () => {
    const template = await seedTemplate({
      id: "tmpl_test_delete_published",
      slug: "delete-test-published",
      status: "published",
      firstPublishedAt: publishedAt,
    });

    const { body, response } = await deleteTemplate(template.id);

    expect(response.status).toBe(409);
    expect(body.error).toMatchObject({ code: "ALREADY_PUBLISHED" });
    expect(typeof (body.error as { message?: unknown }).message).toBe("string");
    expect((body.error as { message: string }).message.length).toBeGreaterThan(
      0,
    );

    const row = await prisma.agentTemplate.findUniqueOrThrow({
      where: { id: template.id },
    });
    expect(row.firstPublishedAt).not.toBeNull();
  });

  test("rejects deleting an unlisted formerly published row", async () => {
    const template = await seedTemplate({
      id: "tmpl_test_delete_unlisted",
      slug: "delete-test-unlisted",
      status: "unlisted",
      firstPublishedAt: publishedAt,
    });

    const { body, response } = await deleteTemplate(template.id);

    expect(response.status).toBe(409);
    expect(body.error).toMatchObject({ code: "ALREADY_PUBLISHED" });
    expect(
      await prisma.agentTemplate.count({ where: { id: template.id } }),
    ).toBe(1);
  });

  test("rejects deleting an archived formerly published row", async () => {
    const template = await seedTemplate({
      id: "tmpl_test_delete_archived",
      slug: "delete-test-archived",
      status: "archived",
      firstPublishedAt: publishedAt,
    });

    const { body, response } = await deleteTemplate(template.id);

    expect(response.status).toBe(409);
    expect(body.error).toMatchObject({ code: "ALREADY_PUBLISHED" });
    expect(
      await prisma.agentTemplate.count({ where: { id: template.id } }),
    ).toBe(1);
  });

  test("keeps forked children and clears forkedFromId when deleting a draft parent", async () => {
    const parent = await seedTemplate({
      id: "tmpl_test_delete_parent",
      slug: "delete-test-parent",
    });
    const child = await seedTemplate({
      id: "tmpl_test_delete_child",
      slug: "delete-test-child",
      forkedFromId: parent.id,
    });

    expect(
      await prisma.agentTemplate.findUniqueOrThrow({
        where: { id: child.id },
        select: { forkedFromId: true },
      }),
    ).toMatchObject({ forkedFromId: parent.id });

    const { response } = await deleteTemplate(parent.id);

    expect(response.status).toBe(200);
    expect(
      await prisma.agentTemplate.findUnique({ where: { id: parent.id } }),
    ).toBeNull();
    expect(
      await prisma.agentTemplate.findUniqueOrThrow({
        where: { id: child.id },
        select: { forkedFromId: true },
      }),
    ).toMatchObject({ forkedFromId: null });
  });

  test("allows reusing a slug after its draft row is hard-deleted", async () => {
    const first = await createTemplate({
      agentName: "Delete Test Reuse",
      prompt: "First prompt",
      slug: "delete-test-reuse",
    });
    expect(first.response.status).toBe(201);

    const deleted = await deleteTemplate(first.body.id as string);
    expect(deleted.response.status).toBe(200);

    const second = await createTemplate({
      agentName: "Delete Test Reuse Again",
      prompt: "Second prompt",
      slug: "delete-test-reuse",
    });

    expect(second.response.status).toBe(201);
    expect(second.body.slug).toBe("delete-test-reuse");
    expect(
      await prisma.agentTemplate.count({
        where: { ownerAccountId: ADMIN_ACCOUNT_ID, slug: "delete-test-reuse" },
      }),
    ).toBe(1);
  });
});
