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

type JsonObject = Record<string, unknown>;

const app = buildAgentTemplatesApp();

let server: Server;
const baseURL = "http://localhost:4054";

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

const hasOwn = (args: { value: object; key: string }) =>
  Object.prototype.hasOwnProperty.call(args.value, args.key);

const testTemplateIds: string[] = [];

const cleanupTemplates = async () => {
  if (testTemplateIds.length > 0) {
    await prisma.agentTemplate.deleteMany({
      where: { id: { in: testTemplateIds } },
    });
  }
  testTemplateIds.length = 0;
};

const createTemplate = async (
  overrides: Partial<Prisma.AgentTemplateUncheckedCreateInput> = {},
) => {
  const id = overrides.id ?? randomUUID();
  testTemplateIds.push(id);
  const firstPublishedAt = hasOwn({ value: overrides, key: "firstPublishedAt" })
    ? overrides.firstPublishedAt
    : new Date("2026-01-20T00:00:00.000Z");

  return prisma.agentTemplate.create({
    data: {
      id,
      slug: overrides.slug ?? `conv-${id.slice(0, 8)}`,
      ownerAccountId: overrides.ownerAccountId ?? ADMIN_ACCOUNT_ID,
      forkedFromId: overrides.forkedFromId ?? null,
      agentName: overrides.agentName ?? `Template ${id}`,
      description: overrides.description ?? "Convention fixture",
      prompt: overrides.prompt ?? `Prompt for ${id}`,
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

// Non-owner reader: read endpoints now require auth, but visibility for a
// non-owner caller matches the old unauthenticated behavior (only published
// templates visible).
const READER_ACCOUNT_ID = "00000000-0000-4000-8000-cccccccc0002";

const readerAuthHeaders = async (): Promise<Record<string, string>> => ({
  "X-Convos-AuthToken": await createJwtToken({
    deviceId: "test-device-agent-templates-conventions",
    accountId: READER_ACCOUNT_ID,
  }),
});

const readJson = async (args: { path: string }) => {
  const response = await fetch(`${baseURL}${args.path}`, {
    headers: await readerAuthHeaders(),
  });
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
      server = app.listen(4054, () => {
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
    const parent = await createTemplate({
      category: "parent-only",
    });
    const child = await createTemplate({
      forkedFromId: parent.id,
      featured: true,
      tools: ["web"],
      connections: ["github"],
      createdAt: new Date("2026-01-20T01:02:03.456Z"),
      firstPublishedAt: new Date("2026-01-20T00:00:00.000Z"),
    });

    const list = await readJson({
      path: "/api/v2/agent-templates?category=conventions",
    });
    const detail = await readJson({
      path: `/api/v2/agent-templates/${child.id}`,
    });

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
      id: child.id,
      ownerAccountId: ADMIN_ACCOUNT_ID,
      forkedFromId: parent.id,
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
      id: child.id,
      ownerAccountId: ADMIN_ACCOUNT_ID,
      forkedFromId: parent.id,
      featured: true,
    });
    expect(detail.body).not.toHaveProperty("owner");
  });

  test("expands owner as a minimal account resource and preserves null firstPublishedAt", async () => {
    const tmpl = await createTemplate({
      slug: "conventions-owner-expand",
      status: "unlisted",
      firstPublishedAt: null,
    });

    const { body, response } = await readJson({
      path: `/api/v2/agent-templates/${tmpl.id}?expand[]=owner`,
    });

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
    const fakeUuid = randomUUID();
    const cases = [
      // `status=bogus` is not a valid enum value → 400; `status=draft` is a
      // valid enum now (auth is required, so the old "auth required" 400 path
      // no longer applies for valid enum values).
      { path: "/api/v2/agent-templates?status=bogus", status: 400 },
      { path: "/api/v2/agent-templates?cursor=!!!", status: 400 },
      { path: `/api/v2/agent-templates/${fakeUuid}`, status: 404 },
      { path: "/api/v2/agent-templates/missing.aaaaa", status: 404 },
    ];

    for (const errorCase of cases) {
      const { body, response } = await readJson({ path: errorCase.path });

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
    const tmpl = await createTemplate();

    const responses = await Promise.all([
      fetch(`${baseURL}/api/v2/agent_templates`),
      fetch(`${baseURL}/api/v2/agent_templates/${tmpl.id}`),
    ]);

    expect(responses.map((response) => response.status)).toEqual([404, 404]);
  });
});
