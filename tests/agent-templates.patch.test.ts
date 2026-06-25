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

const OTHER_ACCOUNT_ID = "bbbbbbbb-cccc-4ddd-eeee-ffffffff0001";

const app = buildAgentTemplatesApp();

let server: Server;
const baseURL = "http://localhost:4061";
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
    deviceId: "test-device-agent-templates-patch",
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
      slug: overrides.slug ?? `patch-test-${id.slice(0, 8)}`,
      ownerAccountId: overrides.ownerAccountId ?? ADMIN_ACCOUNT_ID,
      forkedFromId: overrides.forkedFromId ?? null,
      agentName: overrides.agentName ?? "Patch Test Template",
      jobTitle: overrides.jobTitle ?? null,
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

const patchTemplate = async (args: {
  id: string;
  body: Record<string, unknown>;
}) => {
  const response = await fetch(`${baseURL}/api/v2/agent-templates/${args.id}`, {
    method: "PATCH",
    headers: await makeAuthHeaders(),
    body: JSON.stringify(args.body),
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
  expect(body).not.toHaveProperty("updatedAt");
};

describe("Agent template patch endpoint", () => {
  beforeAll(async () => {
    await new Promise<void>((resolve) => {
      server = app.listen(4061, () => {
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
    const { body, response } = await patchTemplate({
      id: missingId,
      body: {
        description: "x",
      },
    });

    expect(response.status).toBe(404);
    expect(body.error).toBeDefined();
  });

  test("updates content fields immediately without bumping version or firstPublishedAt", async () => {
    const template = await seedTemplate({
      slug: "patch-test-content",
      status: "published",
      firstPublishedAt: publishedAt,
      version: 7,
    });

    const { body, response } = await patchTemplate({
      id: template.id,
      body: {
        prompt: "New prompt",
        tools: ["web_search", "calculator"],
        connections: ["calendar", "gmail"],
        avatarUrl: "https://example.com/avatar.png",
        agentName: "Renamed Patch Test",
        jobTitle: "Group Lead",
        description: "Updated description",
        category: "productivity",
        emoji: "🤖",
      },
    });

    expect(response.status).toBe(200);
    expectTemplateShape(body);
    expect(body).toMatchObject({
      prompt: "New prompt",
      tools: ["web_search", "calculator"],
      connections: ["calendar", "gmail"],
      avatarUrl: "https://example.com/avatar.png",
      agentName: "Renamed Patch Test",
      jobTitle: "Group Lead",
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
    expect(row.jobTitle).toBe("Group Lead");
    expect(row.tools).toEqual(["web_search", "calculator"]);
    expect(row.connections).toEqual(["calendar", "gmail"]);
  });

  test("clears jobTitle when patched with null or blank", async () => {
    for (const clearing of [null, "   "]) {
      const template = await seedTemplate({ jobTitle: "Old Title" });
      const { body, response } = await patchTemplate({
        id: template.id,
        body: { jobTitle: clearing },
      });

      expect(response.status).toBe(200);
      expect(body.jobTitle).toBeNull();

      const row = await prisma.agentTemplate.findUniqueOrThrow({
        where: { id: template.id },
      });
      expect(row.jobTitle).toBeNull();
    }
  });

  test("allows valid pre-publish slug patches and enforces the 64 character boundary", async () => {
    const template = await seedTemplate({
      slug: "patch-test-old",
    });
    const maxLengthSlug = "a".repeat(64);

    const renamed = await patchTemplate({
      id: template.id,
      body: {
        slug: "patch-test-new",
      },
    });
    expect(renamed.response.status).toBe(200);
    expect(renamed.body.slug).toBe("patch-test-new");

    const tooLong = await patchTemplate({
      id: template.id,
      body: { slug: "a".repeat(65) },
    });
    expect(tooLong.response.status).toBe(400);
    expect(
      await prisma.agentTemplate.findUniqueOrThrow({
        where: { id: template.id },
      }),
    ).toMatchObject({ slug: "patch-test-new" });

    const boundary = await patchTemplate({
      id: template.id,
      body: { slug: maxLengthSlug },
    });
    expect(boundary.response.status).toBe(200);
    expect(boundary.body.slug).toBe(maxLengthSlug);
    expect(
      await prisma.agentTemplate.findUniqueOrThrow({
        where: { id: template.id },
      }),
    ).toMatchObject({ slug: maxLengthSlug });
  });

  test("rejects invalid draft slug patches but allows duplicate slugs", async () => {
    await seedTemplate({
      slug: "patch-test-taken",
    });
    const template = await seedTemplate({
      slug: "patch-test-original",
    });

    for (const slug of ["Has-Caps", "with space", "", "generate"]) {
      const result = await patchTemplate({ id: template.id, body: { slug } });
      expect(result.response.status).toBe(400);
      expect(
        await prisma.agentTemplate.findUniqueOrThrow({
          where: { id: template.id },
        }),
      ).toMatchObject({ slug: "patch-test-original" });
    }

    // Slugs are not unique — patching to an already-used slug is accepted.
    const duplicate = await patchTemplate({
      id: template.id,
      body: {
        slug: "patch-test-taken",
      },
    });
    expect(duplicate.response.status).toBe(200);
    expect(
      await prisma.agentTemplate.findUniqueOrThrow({
        where: { id: template.id },
      }),
    ).toMatchObject({ slug: "patch-test-taken" });
  });

  test("rejects slug changes after first publish and preserves the existing slug", async () => {
    const template = await seedTemplate({
      slug: "patch-test-immutable",
      status: "published",
      firstPublishedAt: publishedAt,
    });

    const result = await patchTemplate({
      id: template.id,
      body: {
        slug: "patch-test-moved",
      },
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
      slug: "patch-test-status-published",
      status: "published",
    });

    const toUnlisted = await patchTemplate({
      id: published.id,
      body: {
        status: "unlisted",
      },
    });
    expect(toUnlisted.response.status).toBe(200);
    expect(toUnlisted.body.status).toBe("unlisted");

    const backToPublished = await patchTemplate({
      id: published.id,
      body: {
        status: "published",
      },
    });
    expect(backToPublished.response.status).toBe(200);
    expect(backToPublished.body.status).toBe("published");

    const publishedToArchived = await patchTemplate({
      id: published.id,
      body: {
        status: "archived",
      },
    });
    expect(publishedToArchived.response.status).toBe(200);
    expect(publishedToArchived.body.status).toBe("archived");

    const unlisted = await seedTemplate({
      slug: "patch-test-status-unlisted",
      status: "unlisted",
    });
    const unlistedToArchived = await patchTemplate({
      id: unlisted.id,
      body: {
        status: "archived",
      },
    });
    expect(unlistedToArchived.response.status).toBe(200);
    expect(unlistedToArchived.body.status).toBe("archived");

    const archivedToPublished = await patchTemplate({
      id: unlisted.id,
      body: {
        status: "published",
      },
    });
    expect(archivedToPublished.response.status).toBe(200);
    expect(archivedToPublished.body.status).toBe("published");

    const archived = await seedTemplate({
      slug: "patch-test-status-archived",
      status: "archived",
    });
    const archivedToUnlisted = await patchTemplate({
      id: archived.id,
      body: {
        status: "unlisted",
      },
    });
    expect(archivedToUnlisted.response.status).toBe(200);
    expect(archivedToUnlisted.body.status).toBe("unlisted");
  });

  test("allows published / unlisted / archived → draft (firstPublishedAt preserved, slug stays locked)", async () => {
    for (const status of ["published", "unlisted", "archived"] as const) {
      const template = await seedTemplate({
        slug: `patch-test-to-draft-${status}`,
        status,
      });
      const originalFirstPublishedAt = template.firstPublishedAt;

      const result = await patchTemplate({
        id: template.id,
        body: { status: "draft" },
      });
      expect(result.response.status).toBe(200);
      expect(result.body.status).toBe("draft");

      const row = await prisma.agentTemplate.findUniqueOrThrow({
        where: { id: template.id },
      });
      expect(row.status).toBe("draft");
      // firstPublishedAt is preserved so the slug stays locked and the
      // next POST /publish takes the re-publish (version-bump) path.
      expect(row.firstPublishedAt).toEqual(originalFirstPublishedAt);

      // Slug is still immutable while back in draft.
      const slugAttempt = await patchTemplate({
        id: template.id,
        body: { slug: `renamed-after-draft-${status}` },
      });
      expect(slugAttempt.response.status).toBe(400);
      expect(slugAttempt.body.error).toMatchObject({ code: "SLUG_IMMUTABLE" });
    }
  });

  test("rejects status transitions out of draft via PATCH (must use POST /publish)", async () => {
    for (const target of ["published", "unlisted", "archived"] as const) {
      const template = await seedTemplate({
        slug: `patch-test-from-draft-${target}`,
        status: "draft",
        firstPublishedAt: null,
      });

      const result = await patchTemplate({
        id: template.id,
        body: { status: target },
      });
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
      slug: "patch-test-pinned",
      status: "published",
      firstPublishedAt: publishedAt,
      version: 3,
      createdAt,
    });

    const fakeOtherId = randomUUID();
    const result = await patchTemplate({
      id: template.id,
      body: {
        ownerAccountId: OTHER_ACCOUNT_ID,
        version: 42,
        firstPublishedAt: "2020-01-01T00:00:00.000Z",
        forkedFromId: fakeOtherId,
        createdAt: "2000-01-01T00:00:00.000Z",
        id: fakeOtherId,
      },
    });

    expect(result.response.status).toBe(200);
    expect(result.body).toMatchObject({
      id: template.id,
      ownerAccountId: ADMIN_ACCOUNT_ID,
      version: 3,
      firstPublishedAt: publishedAt.toISOString(),
      forkedFromId: null,
      createdAt: createdAt.toISOString(),
    });

    const row = await prisma.agentTemplate.findUniqueOrThrow({
      where: { id: template.id },
    });
    expect(row.ownerAccountId).toBe(ADMIN_ACCOUNT_ID);
    expect(row.version).toBe(3);
    expect(row.firstPublishedAt?.toISOString()).toBe(publishedAt.toISOString());
    expect(row.forkedFromId).toBeNull();
    expect(row.createdAt.toISOString()).toBe(createdAt.toISOString());
    expect(
      await prisma.agentTemplate.findUnique({
        where: { id: fakeOtherId },
      }),
    ).toBeNull();
  });

  test("returns the full template object and preserves it on an empty body no-op", async () => {
    const template = await seedTemplate({
      slug: "patch-test-empty",
      status: "published",
      firstPublishedAt: publishedAt,
    });

    const first = await patchTemplate({ id: template.id, body: {} });
    expect(first.response.status).toBe(200);
    expectTemplateShape(first.body);
    expect(first.body.firstPublishedAt).toEqual(
      expect.stringMatching(isoTimestampPattern),
    );

    const second = await patchTemplate({ id: template.id, body: {} });
    expect(second.response.status).toBe(200);
    expect(second.body).toEqual(first.body);
  });

  test("a slug PATCH whose pinned WHERE state has shifted underneath it surfaces as 409", async () => {
    const template = await seedTemplate({
      slug: "patch-test-race",
      status: "draft",
    });

    // Stage a request, then before its updateMany lands, mutate the row out
    // from under it. The handler observed slug "patch-test-race" so its
    // WHERE clause pins on that value; once the slug is rewritten by a
    // concurrent client, the WHERE no longer matches and the patch must
    // surface 409 instead of silently overwriting against stale state.
    const concurrentMutation = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await prisma.agentTemplate.update({
        where: { id: template.id },
        data: { slug: "patch-test-race-rewritten" },
      });
    })();

    const [patchResult] = await Promise.all([
      patchTemplate({
        id: template.id,
        body: { description: "racing description" },
      }),
      concurrentMutation,
    ]);

    if (patchResult.response.status === 409) {
      expect(patchResult.body).toMatchObject({
        error: { code: "TEMPLATE_MODIFIED" },
      });
      const row = await prisma.agentTemplate.findUniqueOrThrow({
        where: { id: template.id },
      });
      expect(row.slug).toBe("patch-test-race-rewritten");
      expect(row.description).toBeNull();
    } else {
      expect(patchResult.response.status).toBe(200);
      const row = await prisma.agentTemplate.findUniqueOrThrow({
        where: { id: template.id },
      });
      expect(row.slug).toBe("patch-test-race-rewritten");
      expect(row.description).toBe("racing description");
    }
  });

  test("multiple concurrent slug PATCHes converge to one winner with conflicting peers reporting 409", async () => {
    const template = await seedTemplate({
      slug: "patch-test-race-many",
      status: "draft",
    });

    const candidates = Array.from(
      { length: 6 },
      (_, index) => `patch-test-race-many-${index}`,
    );
    const results = await Promise.all(
      candidates.map((slug) =>
        patchTemplate({ id: template.id, body: { slug } }),
      ),
    );

    const successes = results.filter((r) => r.response.status === 200);
    const conflicts = results.filter((r) => r.response.status === 409);
    // Each handler reads its own snapshot before the WHERE-pinned write, so
    // multiple PATCHes can succeed when their reads observe different
    // committed states. The invariant: every response is either a clean 200
    // or a TEMPLATE_MODIFIED 409, and at least one peer wins.
    expect(successes.length).toBeGreaterThanOrEqual(1);
    expect(successes.length + conflicts.length).toBe(results.length);
    for (const conflict of conflicts) {
      expect(conflict.body).toMatchObject({
        error: { code: "TEMPLATE_MODIFIED" },
      });
    }

    const row = await prisma.agentTemplate.findUniqueOrThrow({
      where: { id: template.id },
    });
    expect(candidates).toContain(row.slug);
  });
});
