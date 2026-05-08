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
import { noRouteMiddleware } from "@/middleware/noRoute";
import { ADMIN_ACCOUNT_ID } from "@/utils/prefixed-id";
import { prisma } from "@/utils/prisma";
import { slugHash } from "@/utils/slug-hash";

type DetailBody = Record<string, unknown>;

const app = express();
app.use("/api/v2/agent-templates", agentTemplatesRouter);
app.use(noRouteMiddleware);

let server: Server;
const baseURL = "http://localhost:4013";

const isoTimestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

const cleanupTemplates = () =>
  prisma.agentTemplate.deleteMany({
    where: { id: { startsWith: "tmpl_test_" } },
  });

const createTemplate = async (
  overrides: Partial<Prisma.AgentTemplateUncheckedCreateInput> & {
    id: string;
  },
) => {
  const slug = overrides.slug ?? overrides.id.replace(/_/g, "-");

  return prisma.agentTemplate.create({
    data: {
      id: overrides.id,
      slug,
      ownerAccountId: overrides.ownerAccountId ?? ADMIN_ACCOUNT_ID,
      forkedFromId: overrides.forkedFromId ?? null,
      agentName: overrides.agentName ?? `Template ${overrides.id}`,
      description: overrides.description ?? "A useful template",
      prompt: overrides.prompt ?? `Prompt for ${overrides.id}`,
      category: overrides.category ?? "utility",
      emoji: overrides.emoji ?? "🤖",
      avatarUrl: overrides.avatarUrl ?? null,
      tools: overrides.tools ?? [],
      connections: overrides.connections ?? [],
      version: overrides.version ?? 1,
      firstPublishedAt:
        overrides.firstPublishedAt ?? new Date("2026-01-10T00:00:00.000Z"),
      status: overrides.status ?? "published",
      featured: overrides.featured ?? false,
      createdAt: overrides.createdAt ?? new Date("2026-01-09T00:00:00.000Z"),
    },
  });
};

const readDetail = async (path: string) => {
  const response = await fetch(`${baseURL}${path}`);
  const contentType = response.headers.get("content-type") ?? "";
  const body = contentType.includes("application/json")
    ? ((await response.json()) as DetailBody)
    : null;

  return { body, response };
};

describe("Agent template detail endpoint", () => {
  beforeAll(async () => {
    await new Promise<void>((resolve) => {
      server = app.listen(4013, () => {
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

  test("resolves a published template by direct id with public camelCase shape", async () => {
    await createTemplate({
      id: "tmpl_test_detail_direct",
      slug: "detail-direct",
      featured: true,
      tools: ["web"],
      connections: ["github"],
    });

    const { body, response } = await readDetail(
      "/api/v2/agent-templates/tmpl_test_detail_direct",
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(body).toMatchObject({
      object: "agent_template",
      id: "tmpl_test_detail_direct",
      slug: "detail-direct",
      ownerAccountId: ADMIN_ACCOUNT_ID,
      forkedFromId: null,
      agentName: "Template tmpl_test_detail_direct",
      prompt: "Prompt for tmpl_test_detail_direct",
      category: "utility",
      emoji: "🤖",
      tools: ["web"],
      connections: ["github"],
      version: 1,
      status: "published",
      featured: true,
    });
    expect(body).not.toHaveProperty("owner");
    expect(body).not.toHaveProperty("skills");
    expect(body).not.toHaveProperty("updatedAt");
    expect(body).not.toHaveProperty("updated_at");
    expect(typeof body?.featured).toBe("boolean");
    expect(body?.createdAt).toMatch(isoTimestampPattern);
    expect(body?.firstPublishedAt).toMatch(isoTimestampPattern);

    const snakeResponse = await fetch(
      `${baseURL}/api/v2/agent_templates/tmpl_test_detail_direct`,
    );
    expect(snakeResponse.status).toBe(404);
  });

  test("resolves by hashed slug and rejects slug-only or mismatched hash lookups", async () => {
    await createTemplate({
      id: "tmpl_test_detail_brewski",
      slug: "brewski",
    });

    const hash = slugHash("tmpl_test_detail_brewski");
    const hashed = await readDetail(`/api/v2/agent-templates/brewski.${hash}`);

    expect(hashed.response.status).toBe(200);
    expect(hashed.body).toMatchObject({
      id: "tmpl_test_detail_brewski",
      slug: "brewski",
    });

    const slugOnly = await fetch(`${baseURL}/api/v2/agent-templates/brewski`);
    expect(slugOnly.status).toBe(404);

    const wrongHash = await fetch(
      `${baseURL}/api/v2/agent-templates/brewski.aaaaa`,
    );
    expect(wrongHash.status).toBe(404);
  });

  test("hides drafts but returns unlisted and archived templates by id and hashed slug", async () => {
    await Promise.all([
      createTemplate({
        id: "tmpl_test_detail_draft",
        slug: "detail-draft",
        status: "draft",
        firstPublishedAt: null,
      }),
      createTemplate({
        id: "tmpl_test_detail_unlisted",
        slug: "detail-unlisted",
        status: "unlisted",
      }),
      createTemplate({
        id: "tmpl_test_detail_archived",
        slug: "detail-archived",
        status: "archived",
      }),
    ]);

    for (const path of [
      "/api/v2/agent-templates/tmpl_test_detail_draft",
      `/api/v2/agent-templates/detail-draft.${slugHash(
        "tmpl_test_detail_draft",
      )}`,
    ]) {
      const response = await fetch(`${baseURL}${path}`);
      expect(response.status).toBe(404);
    }

    for (const fixture of [
      {
        id: "tmpl_test_detail_unlisted",
        slug: "detail-unlisted",
        status: "unlisted",
      },
      {
        id: "tmpl_test_detail_archived",
        slug: "detail-archived",
        status: "archived",
      },
    ]) {
      const byId = await readDetail(`/api/v2/agent-templates/${fixture.id}`);
      expect(byId.response.status).toBe(200);
      expect(byId.body?.status).toBe(fixture.status);

      const byHash = await readDetail(
        `/api/v2/agent-templates/${fixture.slug}.${slugHash(fixture.id)}`,
      );
      expect(byHash.response.status).toBe(200);
      expect(byHash.body?.status).toBe(fixture.status);
    }
  });

  test("supports owner and skills expansions while ignoring unknown expansion values", async () => {
    await createTemplate({
      id: "tmpl_test_detail_expand",
      slug: "detail-expand",
    });

    const defaultDetail = await readDetail(
      "/api/v2/agent-templates/tmpl_test_detail_expand",
    );
    expect(defaultDetail.response.status).toBe(200);
    expect(defaultDetail.body?.ownerAccountId).toBe(ADMIN_ACCOUNT_ID);
    expect(defaultDetail.body).not.toHaveProperty("owner");
    expect(defaultDetail.body).not.toHaveProperty("skills");

    const ownerExpanded = await readDetail(
      "/api/v2/agent-templates/tmpl_test_detail_expand?expand[]=owner",
    );
    expect(ownerExpanded.response.status).toBe(200);
    expect(ownerExpanded.body).not.toHaveProperty("ownerAccountId");
    const owner = ownerExpanded.body?.owner as Record<string, unknown>;
    expect(owner.object).toBe("account");
    expect(owner.id).toBe(ADMIN_ACCOUNT_ID);
    expect(owner.createdAt).toEqual(expect.stringMatching(isoTimestampPattern));
    expect(Object.keys(owner).sort()).toEqual(["createdAt", "id", "object"]);

    const skillsExpanded = await readDetail(
      "/api/v2/agent-templates/tmpl_test_detail_expand?expand[]=skills",
    );
    expect(skillsExpanded.response.status).toBe(200);
    expect(skillsExpanded.body?.skills).toEqual([]);

    const skillsFilesExpanded = await readDetail(
      "/api/v2/agent-templates/tmpl_test_detail_expand?expand[]=skills.files",
    );
    expect(skillsFilesExpanded.response.status).toBe(200);
    expect(skillsFilesExpanded.body?.skills).toEqual([]);

    const combined = await readDetail(
      "/api/v2/agent-templates/tmpl_test_detail_expand?expand[]=owner&expand[]=skills",
    );
    expect(combined.response.status).toBe(200);
    expect(combined.body).not.toHaveProperty("ownerAccountId");
    expect(combined.body?.owner).toMatchObject({
      object: "account",
      id: ADMIN_ACCOUNT_ID,
    });
    expect(combined.body?.skills).toEqual([]);

    const unknown = await readDetail(
      "/api/v2/agent-templates/tmpl_test_detail_expand?expand[]=bogus",
    );
    expect(unknown.response.status).toBe(200);
    expect(unknown.body).toEqual(defaultDetail.body);
  });
});
