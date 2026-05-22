import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { Prisma } from "@prisma/client";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";
import { ADMIN_ACCOUNT_ID } from "@/utils/constants";
import { createJwtToken } from "@/utils/jwt";
import { prisma } from "@/utils/prisma";
import { buildAgentTemplatesApp } from "./agent-templates.cross.helpers";

type TemplateBody = Record<string, unknown>;

const app = buildAgentTemplatesApp();

let server: Server;
const baseURL = "http://localhost:4063";
const publishedAt = new Date("2026-02-01T12:00:00.000Z");
const createdAt = new Date("2026-01-31T12:00:00.000Z");

const testTemplateIds: string[] = [];

const cleanupTemplates = async () => {
  if (testTemplateIds.length > 0) {
    await prisma.agentTemplate.deleteMany({
      where: { id: { in: testTemplateIds } },
    });
  }
  await prisma.agentTemplate.deleteMany({
    where: {
      ownerAccountId: ADMIN_ACCOUNT_ID,
      OR: [
        { slug: { startsWith: "delete-test-" } },
        { agentName: { startsWith: "Delete Test" } },
      ],
    },
  });
  testTemplateIds.length = 0;
};

const makeAuthHeaders = async () => ({
  "Content-Type": "application/json",
  "X-Convos-AuthToken": await createJwtToken({
    deviceId: "test-device-agent-templates-delete",
    accountId: ADMIN_ACCOUNT_ID,
  }),
});

const seedTemplate = async (
  overrides: Partial<Prisma.AgentTemplateUncheckedCreateInput> = {},
) => {
  const id = overrides.id ?? randomUUID();
  testTemplateIds.push(id);
  const status = overrides.status ?? "draft";
  const defaultFirstPublishedAt =
    status === "draft" ? null : new Date(publishedAt);

  return prisma.agentTemplate.create({
    data: {
      id,
      slug: overrides.slug ?? `delete-test-${id.slice(0, 8)}`,
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
      server = app.listen(4063, () => {
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
    const missingId = randomUUID();
    const { body, response } = await deleteTemplate(missingId);

    expect(response.status).toBe(404);
    expect(body.error).toBeDefined();
  });

  test("hard-deletes a draft and returns the exact JSON tombstone shape", async () => {
    const template = await seedTemplate({
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

  test("deletes a published row (no more ALREADY_PUBLISHED gate)", async () => {
    const template = await seedTemplate({
      slug: "delete-test-published",
      status: "published",
      firstPublishedAt: publishedAt,
    });

    const { body, response } = await deleteTemplate(template.id);

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      object: "agent_template",
      id: template.id,
      deleted: true,
    });
    expect(
      await prisma.agentTemplate.count({ where: { id: template.id } }),
    ).toBe(0);
  });

  test("deletes an unlisted formerly published row", async () => {
    const template = await seedTemplate({
      slug: "delete-test-unlisted",
      status: "unlisted",
      firstPublishedAt: publishedAt,
    });

    const { response } = await deleteTemplate(template.id);

    expect(response.status).toBe(200);
    expect(
      await prisma.agentTemplate.count({ where: { id: template.id } }),
    ).toBe(0);
  });

  test("deletes an archived formerly published row", async () => {
    const template = await seedTemplate({
      slug: "delete-test-archived",
      status: "archived",
      firstPublishedAt: publishedAt,
    });

    const { response } = await deleteTemplate(template.id);

    expect(response.status).toBe(200);
    expect(
      await prisma.agentTemplate.count({ where: { id: template.id } }),
    ).toBe(0);
  });

  test("keeps forked children and clears forkedFromId when deleting a draft parent", async () => {
    const parent = await seedTemplate({
      slug: "delete-test-parent",
    });
    const child = await seedTemplate({
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
