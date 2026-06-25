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
const baseURL = "http://localhost:4065";
const publishedAt = new Date("2026-02-01T12:00:00.000Z");
const createdAt = new Date("2026-01-31T12:00:00.000Z");
const isoTimestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

const testTemplateIds: string[] = [];

const cleanupTemplates = async () => {
  if (testTemplateIds.length > 0) {
    await prisma.agentTemplate.deleteMany({
      where: { id: { in: testTemplateIds } },
    });
  }
  testTemplateIds.length = 0;
};

const makeAuthHeaders = async () => ({
  "Content-Type": "application/json",
  "X-Convos-AuthToken": await createJwtToken({
    deviceId: "test-device-agent-templates-publish",
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
      slug: overrides.slug ?? `publish-test-${id.slice(0, 8)}`,
      ownerAccountId: overrides.ownerAccountId ?? ADMIN_ACCOUNT_ID,
      forkedFromId: overrides.forkedFromId ?? null,
      agentName: overrides.agentName ?? "Publish Test Template",
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

const publishTemplate = async (id: string, query = "") => {
  const response = await fetch(
    `${baseURL}/api/v2/agent-templates/${id}/publish${query}`,
    {
      method: "POST",
      headers: await makeAuthHeaders(),
    },
  );
  const body = (await response.json()) as TemplateBody;

  return { body, response };
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
    "jobTitle",
    "object",
    "ownerAccountId",
    "prompt",
    "publishedUrl",
    "slug",
    "status",
    "tools",
    "version",
  ]);
  expect(body.object).toBe("agent_template");
  expect(body.createdAt).toEqual(expect.stringMatching(isoTimestampPattern));
  expect(body.firstPublishedAt).toEqual(
    expect.stringMatching(isoTimestampPattern),
  );
  expect(body).not.toHaveProperty("updatedAt");
};

describe("Agent template publish endpoint", () => {
  beforeAll(async () => {
    await new Promise<void>((resolve) => {
      server = app.listen(4065, () => {
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
    const { body, response } = await publishTemplate(missingId);

    expect(response.status).toBe(404);
    expect(body.error).toBeDefined();
  });

  test("first publish defaults draft to published, sets firstPublishedAt, and keeps version 1", async () => {
    const template = await seedTemplate({
      slug: "publish-test-default",
    });
    const startedAt = Date.now();

    const { body, response } = await publishTemplate(template.id);

    expect(response.status).toBe(200);
    expectTemplateShape(body);
    expect(body).toMatchObject({
      id: template.id,
      status: "published",
      version: 1,
    });
    expect(
      new Date(body.firstPublishedAt as string).getTime(),
    ).toBeGreaterThanOrEqual(startedAt);
    expect(
      new Date(body.firstPublishedAt as string).getTime(),
    ).toBeLessThanOrEqual(Date.now());

    const row = await prisma.agentTemplate.findUniqueOrThrow({
      where: { id: template.id },
    });
    expect(row.status).toBe("published");
    expect(row.version).toBe(1);
    expect(row.firstPublishedAt).not.toBeNull();
  });

  test("first publish honors status=unlisted without bumping version", async () => {
    const template = await seedTemplate({
      slug: "publish-test-unlisted-first",
    });

    const { body, response } = await publishTemplate(
      template.id,
      "?status=unlisted",
    );

    expect(response.status).toBe(200);
    expectTemplateShape(body);
    expect(body).toMatchObject({
      id: template.id,
      status: "unlisted",
      version: 1,
    });

    const row = await prisma.agentTemplate.findUniqueOrThrow({
      where: { id: template.id },
    });
    expect(row.status).toBe("unlisted");
    expect(row.version).toBe(1);
    expect(row.firstPublishedAt).not.toBeNull();
  });

  test("first publish rejects invalid status params and leaves draft rows unchanged", async () => {
    for (const status of ["draft", "archived", "garbage"]) {
      const template = await seedTemplate({
        slug: `publish-test-invalid-${status}`,
      });

      const { body, response } = await publishTemplate(
        template.id,
        `?status=${status}`,
      );

      expect(response.status).toBe(400);
      expect(body.error).toBeDefined();
      expect(
        await prisma.agentTemplate.findUniqueOrThrow({
          where: { id: template.id },
        }),
      ).toMatchObject({
        status: "draft",
        version: 1,
        firstPublishedAt: null,
      });
    }
  });

  test("subsequent publish increments version and preserves published status and firstPublishedAt", async () => {
    const template = await seedTemplate({
      slug: "publish-test-subsequent",
      status: "published",
      firstPublishedAt: publishedAt,
      version: 1,
    });

    const { body, response } = await publishTemplate(template.id);

    expect(response.status).toBe(200);
    expectTemplateShape(body);
    expect(body).toMatchObject({
      status: "published",
      version: 2,
      firstPublishedAt: publishedAt.toISOString(),
    });

    const row = await prisma.agentTemplate.findUniqueOrThrow({
      where: { id: template.id },
    });
    expect(row.status).toBe("published");
    expect(row.version).toBe(2);
    expect(row.firstPublishedAt?.toISOString()).toBe(publishedAt.toISOString());
  });

  test("subsequent publish preserves unlisted and archived statuses while bumping version", async () => {
    for (const status of ["unlisted", "archived"] as const) {
      const template = await seedTemplate({
        slug: `publish-test-preserve-${status}`,
        status,
        firstPublishedAt: publishedAt,
        version: 4,
      });

      const { body, response } = await publishTemplate(template.id);

      expect(response.status).toBe(200);
      expectTemplateShape(body);
      expect(body).toMatchObject({
        status,
        version: 5,
        firstPublishedAt: publishedAt.toISOString(),
      });

      const row = await prisma.agentTemplate.findUniqueOrThrow({
        where: { id: template.id },
      });
      expect(row.status).toBe(status);
      expect(row.version).toBe(5);
      expect(row.firstPublishedAt?.toISOString()).toBe(
        publishedAt.toISOString(),
      );
    }
  });

  test("subsequent publish ignores status=unlisted and keeps the current status", async () => {
    const template = await seedTemplate({
      slug: "publish-test-ignore-status-param",
      status: "published",
      firstPublishedAt: publishedAt,
      version: 8,
    });

    const { body, response } = await publishTemplate(
      template.id,
      "?status=unlisted",
    );

    expect(response.status).toBe(200);
    expectTemplateShape(body);
    expect(body).toMatchObject({
      status: "published",
      version: 9,
      firstPublishedAt: publishedAt.toISOString(),
    });

    const row = await prisma.agentTemplate.findUniqueOrThrow({
      where: { id: template.id },
    });
    expect(row.status).toBe("published");
    expect(row.version).toBe(9);
    expect(row.firstPublishedAt?.toISOString()).toBe(publishedAt.toISOString());
  });

  test("re-publish on a published-then-drafted row brings it back out of draft", async () => {
    // Models the round-trip: status was set to `draft` via PATCH after a
    // first publish (allowed once firstPublishedAt is set — see patch.ts).
    // /publish must take it back out of draft, honour ?status= when
    // provided, and bump version. firstPublishedAt is preserved (it was
    // already non-null from the original publish).
    const template = await seedTemplate({
      slug: "publish-test-redraft-republish",
      status: "draft",
      firstPublishedAt: publishedAt,
      version: 1,
    });

    const { body, response } = await publishTemplate(template.id);
    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      status: "published",
      version: 2,
      firstPublishedAt: publishedAt.toISOString(),
    });

    const row = await prisma.agentTemplate.findUniqueOrThrow({
      where: { id: template.id },
    });
    expect(row.status).toBe("published");
    expect(row.version).toBe(2);
  });

  test("re-publish on a published-then-drafted row honours ?status=unlisted", async () => {
    const template = await seedTemplate({
      slug: "publish-test-redraft-republish-unlisted",
      status: "draft",
      firstPublishedAt: publishedAt,
      version: 3,
    });

    const { body, response } = await publishTemplate(
      template.id,
      "?status=unlisted",
    );
    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      status: "unlisted",
      version: 4,
      firstPublishedAt: publishedAt.toISOString(),
    });
  });
});
