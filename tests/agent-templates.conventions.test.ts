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

type JsonObject = Record<string, unknown>;

const app = express();
app.use("/api/v2/agent-templates", agentTemplatesRouter);
app.use(noRouteMiddleware);

let server: Server;
const baseURL = "http://localhost:4014";

const isoTimestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const camelCaseKeyPattern = /^[a-z][A-Za-z0-9]*$/;
const forbiddenKeys = [
  "agent_name",
  "first_published_at",
  "created_at",
  "updated_at",
  "forked_from_id",
  "owner_account_id",
  "avatar_url",
  "has_more",
  "next_cursor",
  "updatedAt",
];

const hasOwn = (value: object, key: string) =>
  Object.prototype.hasOwnProperty.call(value, key);

const cleanupTemplates = () =>
  prisma.agentTemplate.deleteMany({
    where: { id: { startsWith: "tmpl_test_" } },
  });

const createTemplate = async (
  overrides: Partial<Prisma.AgentTemplateUncheckedCreateInput> & {
    id: string;
  },
) => {
  const firstPublishedAt = hasOwn(overrides, "firstPublishedAt")
    ? overrides.firstPublishedAt
    : new Date("2026-01-20T00:00:00.000Z");

  return prisma.agentTemplate.create({
    data: {
      id: overrides.id,
      slug: overrides.slug ?? overrides.id.replace(/_/g, "-"),
      ownerAccountId: overrides.ownerAccountId ?? ADMIN_ACCOUNT_ID,
      forkedFromId: overrides.forkedFromId ?? null,
      agentName: overrides.agentName ?? `Template ${overrides.id}`,
      description: overrides.description ?? "Convention fixture",
      prompt: overrides.prompt ?? `Prompt for ${overrides.id}`,
      category: overrides.category ?? "conventions",
      emoji: overrides.emoji ?? "🤖",
      avatarUrl: overrides.avatarUrl ?? null,
      tools: overrides.tools ?? [],
      connections: overrides.connections ?? [],
      version: overrides.version ?? 1,
      firstPublishedAt,
      status: overrides.status ?? "published",
      featured: overrides.featured ?? false,
      createdAt: overrides.createdAt ?? new Date("2026-01-19T00:00:00.000Z"),
    },
  });
};

const readJson = async (path: string) => {
  const response = await fetch(`${baseURL}${path}`);
  const body = (await response.json()) as JsonObject;

  return { body, response };
};

const collectKeys = (value: unknown, keys = new Set<string>()) => {
  if (Array.isArray(value)) {
    value.forEach((item) => collectKeys(item, keys));
    return keys;
  }

  if (typeof value !== "object" || value === null) {
    return keys;
  }

  Object.entries(value).forEach(([key, child]) => {
    keys.add(key);
    collectKeys(child, keys);
  });

  return keys;
};

const collectTimestampValues = (
  value: unknown,
  timestamps: Array<{ key: string; value: unknown }> = [],
) => {
  if (Array.isArray(value)) {
    value.forEach((item) => collectTimestampValues(item, timestamps));
    return timestamps;
  }

  if (typeof value !== "object" || value === null) {
    return timestamps;
  }

  Object.entries(value).forEach(([key, child]) => {
    if (key.endsWith("At")) {
      timestamps.push({ key, value: child });
    }
    collectTimestampValues(child, timestamps);
  });

  return timestamps;
};

const expectConventionalKeys = (body: unknown) => {
  const keys = [...collectKeys(body)];

  for (const key of keys) {
    expect(key).toMatch(camelCaseKeyPattern);
  }

  for (const key of forbiddenKeys) {
    expect(keys).not.toContain(key);
  }
};

const expectTimestampValues = (body: unknown) => {
  for (const timestamp of collectTimestampValues(body)) {
    if (timestamp.key === "firstPublishedAt" && timestamp.value === null) {
      continue;
    }

    expect(timestamp.value).toEqual(expect.stringMatching(isoTimestampPattern));
  }
};

describe("Agent template read response conventions", () => {
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

  test("serializes list and detail bodies with camelCase keys, discriminators, booleans, and Z timestamps", async () => {
    await createTemplate({
      id: "tmpl_test_conventions_parent",
      category: "parent-only",
    });
    await createTemplate({
      id: "tmpl_test_conventions_child",
      forkedFromId: "tmpl_test_conventions_parent",
      featured: true,
      tools: ["web"],
      connections: ["github"],
      createdAt: new Date("2026-01-20T01:02:03.456Z"),
      firstPublishedAt: new Date("2026-01-20T00:00:00.000Z"),
    });

    const list = await readJson("/api/v2/agent-templates?category=conventions");
    const detail = await readJson(
      "/api/v2/agent-templates/tmpl_test_conventions_child",
    );

    expect(list.response.status).toBe(200);
    expect(list.response.headers.get("content-type")).toContain(
      "application/json",
    );
    expect(Object.keys(list.body).sort()).toEqual([
      "data",
      "hasMore",
      "nextCursor",
    ]);
    expectConventionalKeys(list.body);
    expectTimestampValues(list.body);

    const rows = list.body.data as JsonObject[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      object: "agent_template",
      id: "tmpl_test_conventions_child",
      ownerAccountId: ADMIN_ACCOUNT_ID,
      forkedFromId: "tmpl_test_conventions_parent",
      featured: true,
      status: "published",
    });
    expect(typeof rows[0]?.ownerAccountId).toBe("string");
    expect(typeof rows[0]?.forkedFromId).toBe("string");
    expect(typeof rows[0]?.featured).toBe("boolean");

    expect(detail.response.status).toBe(200);
    expect(detail.response.headers.get("content-type")).toContain(
      "application/json",
    );
    expectConventionalKeys(detail.body);
    expectTimestampValues(detail.body);
    expect(detail.body).toMatchObject({
      object: "agent_template",
      id: "tmpl_test_conventions_child",
      ownerAccountId: ADMIN_ACCOUNT_ID,
      forkedFromId: "tmpl_test_conventions_parent",
      featured: true,
    });
    expect(detail.body).not.toHaveProperty("owner");
  });

  test("expands owner as a minimal account resource and preserves null firstPublishedAt", async () => {
    await createTemplate({
      id: "tmpl_test_conventions_owner_expand",
      slug: "conventions-owner-expand",
      status: "unlisted",
      firstPublishedAt: null,
    });

    const { body, response } = await readJson(
      "/api/v2/agent-templates/tmpl_test_conventions_owner_expand?expand[]=owner",
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expectConventionalKeys(body);
    expectTimestampValues(body);
    expect(body.object).toBe("agent_template");
    expect(body.firstPublishedAt).toBeNull();
    expect(body).not.toHaveProperty("ownerAccountId");

    const owner = body.owner as JsonObject;
    expect(owner).toBeDefined();
    expect(owner.object).toBe("account");
    expect(owner.id).toBe(ADMIN_ACCOUNT_ID);
    expect(owner.createdAt).toEqual(expect.stringMatching(isoTimestampPattern));
    expect(Object.keys(owner).sort()).toEqual(["createdAt", "id", "object"]);
  });

  test("returns JSON content type and parseable JSON bodies for read errors", async () => {
    const cases = [
      { path: "/api/v2/agent-templates?status=draft", status: 400 },
      { path: "/api/v2/agent-templates?cursor=!!!", status: 400 },
      { path: "/api/v2/agent-templates/tmpl_test_missing", status: 404 },
      { path: "/api/v2/agent-templates/missing.aaaaa", status: 404 },
    ];

    for (const errorCase of cases) {
      const { body, response } = await readJson(errorCase.path);

      expect(response.status).toBe(errorCase.status);
      expect(response.headers.get("content-type")).toContain(
        "application/json",
      );
      expect(typeof body).toBe("object");
      expect(body).not.toBeNull();
      expectConventionalKeys(body);
    }
  });

  test("keeps underscore read paths unmounted", async () => {
    await createTemplate({ id: "tmpl_test_conventions_underscore" });

    const responses = await Promise.all([
      fetch(`${baseURL}/api/v2/agent_templates`),
      fetch(
        `${baseURL}/api/v2/agent_templates/tmpl_test_conventions_underscore`,
      ),
    ]);

    expect(responses.map((response) => response.status)).toEqual([404, 404]);
  });
});
