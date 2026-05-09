import type { Server } from "node:http";
import type { AgentTemplate, Prisma } from "@prisma/client";
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

type ListEnvelope = {
  data: Array<Record<string, unknown>>;
  hasMore: boolean;
  nextCursor: string | null;
};

const app = express();
app.use(pinoMiddleware);
app.use(jsonMiddleware);
app.use("/api/v2/agent-templates", agentTemplatesRouter);
app.use(noRouteMiddleware);

let server: Server;
const baseURL = "http://localhost:4012";

const cleanupTemplates = () =>
  prisma.agentTemplate.deleteMany({
    where: { id: { startsWith: "tmpl_test_" } },
  });

const encodeCursor = (cursor: { id: string; createdAt: string }) =>
  Buffer.from(JSON.stringify(cursor)).toString("base64url");

const readList = async (path = "/api/v2/agent-templates") => {
  const response = await fetch(`${baseURL}${path}`);
  const body = (await response.json()) as ListEnvelope;

  return { body, response };
};

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
      description: overrides.description ?? null,
      prompt: overrides.prompt ?? `Prompt for ${overrides.id}`,
      category: overrides.category ?? null,
      emoji: overrides.emoji ?? null,
      avatarUrl: overrides.avatarUrl ?? null,
      tools: overrides.tools ?? [],
      connections: overrides.connections ?? [],
      version: overrides.version ?? 1,
      firstPublishedAt: overrides.firstPublishedAt ?? null,
      status: overrides.status ?? "published",
      featured: overrides.featured ?? false,
      createdAt: overrides.createdAt ?? new Date(),
    },
  });
};

const ids = (rows: Array<{ id?: unknown }>) => rows.map((row) => row.id);

describe("Agent template list endpoint", () => {
  beforeAll(async () => {
    await new Promise<void>((resolve) => {
      server = app.listen(4012, () => {
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

  test("returns a public camelCase envelope from the kebab path and keeps snake path unmounted", async () => {
    await createTemplate({ id: "tmpl_test_public_envelope" });

    const { body, response } = await readList();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(Object.keys(body).sort()).toEqual(["data", "hasMore", "nextCursor"]);
    expect(Array.isArray(body.data)).toBe(true);
    expect(typeof body.hasMore).toBe("boolean");
    expect(
      body.nextCursor === null || typeof body.nextCursor === "string",
    ).toBe(true);
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({
      object: "agent_template",
      id: "tmpl_test_public_envelope",
      ownerAccountId: ADMIN_ACCOUNT_ID,
      status: "published",
    });
    expect(body.data[0]?.id).toMatch(/^tmpl_/);
    expect(body.data[0]).not.toHaveProperty("updatedAt");

    const authToken = await createJwtToken({
      deviceId: "test-device-agent-templates-list",
    });
    const authedResponse = await fetch(`${baseURL}/api/v2/agent-templates`, {
      headers: { "X-Convos-AuthToken": authToken },
    });
    const authedBody = (await authedResponse.json()) as ListEnvelope;
    expect(authedResponse.status).toBe(200);
    expect(ids(authedBody.data)).toEqual(ids(body.data));

    const snakeResponse = await fetch(`${baseURL}/api/v2/agent_templates`);
    expect(snakeResponse.status).toBe(404);
  });

  test("omits non-published rows and composes category owner and featured filters", async () => {
    await Promise.all([
      createTemplate({
        id: "tmpl_test_filters_draft",
        status: "draft",
        category: "utility",
        featured: true,
      }),
      createTemplate({
        id: "tmpl_test_filters_published_featured",
        status: "published",
        category: "utility",
        featured: true,
      }),
      createTemplate({
        id: "tmpl_test_filters_published_plain",
        status: "published",
        category: "entertainment",
        featured: false,
      }),
      createTemplate({
        id: "tmpl_test_filters_unlisted",
        status: "unlisted",
        category: "utility",
        featured: true,
      }),
      createTemplate({
        id: "tmpl_test_filters_archived",
        status: "archived",
        category: "utility",
        featured: true,
      }),
    ]);

    const defaultList = await readList();
    expect(defaultList.response.status).toBe(200);
    expect(ids(defaultList.body.data).sort()).toEqual([
      "tmpl_test_filters_published_featured",
      "tmpl_test_filters_published_plain",
    ]);

    const utility = await readList("/api/v2/agent-templates?category=utility");
    expect(ids(utility.body.data)).toEqual([
      "tmpl_test_filters_published_featured",
    ]);

    const entertainment = await readList(
      "/api/v2/agent-templates?category=entertainment",
    );
    expect(ids(entertainment.body.data)).toEqual([
      "tmpl_test_filters_published_plain",
    ]);

    const missingCategory = await readList(
      "/api/v2/agent-templates?category=nonexistent",
    );
    expect(missingCategory.body).toEqual({
      data: [],
      hasMore: false,
      nextCursor: null,
    });

    const owner = await readList(
      `/api/v2/agent-templates?owner=${ADMIN_ACCOUNT_ID}`,
    );
    expect(ids(owner.body.data).sort()).toEqual(
      ids(defaultList.body.data).sort(),
    );

    const missingOwner = await readList(
      "/api/v2/agent-templates?owner=acct_does_not_exist",
    );
    expect(missingOwner.body).toEqual({
      data: [],
      hasMore: false,
      nextCursor: null,
    });

    const featured = await readList("/api/v2/agent-templates?featured=true");
    expect(ids(featured.body.data)).toEqual([
      "tmpl_test_filters_published_featured",
    ]);

    const featuredFalse = await readList(
      "/api/v2/agent-templates?featured=false",
    );
    expect(ids(featuredFalse.body.data).sort()).toEqual(
      ids(defaultList.body.data).sort(),
    );

    const featuredAnything = await readList(
      "/api/v2/agent-templates?featured=anything",
    );
    expect(ids(featuredAnything.body.data).sort()).toEqual(
      ids(defaultList.body.data).sort(),
    );

    const composed = await readList(
      `/api/v2/agent-templates?category=utility&owner=${ADMIN_ACCOUNT_ID}&featured=true`,
    );
    expect(ids(composed.body.data)).toEqual([
      "tmpl_test_filters_published_featured",
    ]);
  });

  test("rejects status, invalid limits, and malformed cursors with 400", async () => {
    for (const status of [
      "draft",
      "published",
      "unlisted",
      "archived",
      "anything",
      "",
    ]) {
      const response = await fetch(
        `${baseURL}/api/v2/agent-templates?status=${status}`,
      );
      expect(response.status).toBe(400);
      expect(response.headers.get("content-type")).toContain(
        "application/json",
      );
    }

    for (const limit of ["0", "-1", "abc", "1.5"]) {
      const response = await fetch(
        `${baseURL}/api/v2/agent-templates?limit=${limit}`,
      );
      expect(response.status).toBe(400);
    }

    const malformedJsonCursor = Buffer.from(
      JSON.stringify({ malformed: true }),
    ).toString("base64url");

    for (const cursor of [
      "not-a-real-cursor",
      "!!!",
      "",
      malformedJsonCursor,
    ]) {
      const response = await fetch(
        `${baseURL}/api/v2/agent-templates?cursor=${cursor}`,
      );
      expect(response.status).toBe(400);
    }
  });

  test("orders by createdAt descending then id descending", async () => {
    const tieCreatedAt = new Date("2026-01-01T00:00:00.000Z");
    await Promise.all([
      createTemplate({
        id: "tmpl_test_order_older",
        createdAt: new Date("2025-12-31T23:59:58.000Z"),
      }),
      createTemplate({
        id: "tmpl_test_order_newer",
        createdAt: new Date("2025-12-31T23:59:59.000Z"),
      }),
      createTemplate({
        id: "tmpl_test_order_tie_a",
        createdAt: tieCreatedAt,
      }),
      createTemplate({
        id: "tmpl_test_order_tie_b",
        createdAt: tieCreatedAt,
      }),
    ]);

    const { body } = await readList();

    expect(ids(body.data)).toEqual([
      "tmpl_test_order_tie_b",
      "tmpl_test_order_tie_a",
      "tmpl_test_order_newer",
      "tmpl_test_order_older",
    ]);
  });

  test("uses default limit 20, clamps to 100, and returns cursor echoing the last row", async () => {
    const baseTime = Date.parse("2026-01-02T00:00:00.000Z");
    const rows: AgentTemplate[] = [];

    for (let index = 0; index < 120; index += 1) {
      rows.push(
        await createTemplate({
          id: `tmpl_test_limit_${String(index).padStart(3, "0")}`,
          createdAt: new Date(baseTime + index * 1000),
        }),
      );
    }

    const defaultPage = await readList();
    expect(defaultPage.body.data).toHaveLength(20);
    expect(defaultPage.body.hasMore).toBe(true);
    expect(typeof defaultPage.body.nextCursor).toBe("string");

    const lastDefaultRow = defaultPage.body.data[19] as {
      id: string;
      createdAt: string;
    };
    const decodedDefaultCursor = JSON.parse(
      Buffer.from(defaultPage.body.nextCursor ?? "", "base64url").toString(),
    ) as { id: string; createdAt: string };
    expect(decodedDefaultCursor.id).toBe(lastDefaultRow.id);
    expect(decodedDefaultCursor.createdAt).toBe(lastDefaultRow.createdAt);

    const clamped = await readList("/api/v2/agent-templates?limit=200");
    expect(clamped.body.data).toHaveLength(100);
    expect(clamped.body.hasMore).toBe(true);

    const explicitMax = await readList("/api/v2/agent-templates?limit=100");
    expect(explicitMax.body.data).toHaveLength(100);

    expect(ids(defaultPage.body.data)).toEqual(
      rows
        .slice(-20)
        .reverse()
        .map((row) => row.id),
    );
  });

  test("round-trips a keyset cursor without duplicates or skips", async () => {
    const baseTime = Date.parse("2026-01-03T00:00:00.000Z");

    for (let index = 0; index < 25; index += 1) {
      await createTemplate({
        id: `tmpl_test_page_${String(index).padStart(3, "0")}`,
        createdAt: new Date(baseTime + index * 1000),
      });
    }

    const firstPage = await readList("/api/v2/agent-templates?limit=20");
    expect(firstPage.body.data).toHaveLength(20);
    expect(firstPage.body.hasMore).toBe(true);
    expect(firstPage.body.nextCursor).not.toBeNull();

    const secondPage = await readList(
      `/api/v2/agent-templates?limit=20&cursor=${firstPage.body.nextCursor}`,
    );
    expect(secondPage.body.data).toHaveLength(5);
    expect(secondPage.body.hasMore).toBe(false);
    expect(secondPage.body.nextCursor).toBeNull();

    const firstIds = new Set(ids(firstPage.body.data));
    const secondIds = new Set(ids(secondPage.body.data));
    const allIds = new Set([...firstIds, ...secondIds]);

    expect([...firstIds].some((id) => secondIds.has(id))).toBe(false);
    expect(allIds).toEqual(
      new Set(
        Array.from(
          { length: 25 },
          (_value, index) => `tmpl_test_page_${String(index).padStart(3, "0")}`,
        ),
      ),
    );
  });

  test("applies cursors inside active filters", async () => {
    const baseTime = Date.parse("2026-01-04T00:00:00.000Z");

    for (let index = 0; index < 21; index += 1) {
      await createTemplate({
        id: `tmpl_test_cursor_utility_${String(index).padStart(3, "0")}`,
        category: "utility",
        createdAt: new Date(baseTime + index * 1000),
      });
    }

    for (let index = 0; index < 5; index += 1) {
      await createTemplate({
        id: `tmpl_test_cursor_entertainment_${String(index).padStart(3, "0")}`,
        category: "entertainment",
        createdAt: new Date(baseTime + (100 + index) * 1000),
      });
    }

    const firstPage = await readList(
      "/api/v2/agent-templates?category=utility&limit=20",
    );
    expect(firstPage.body.data).toHaveLength(20);
    expect(firstPage.body.nextCursor).not.toBeNull();
    expect(firstPage.body.data.every((row) => row.category === "utility")).toBe(
      true,
    );

    const secondPage = await readList(
      `/api/v2/agent-templates?category=utility&limit=20&cursor=${firstPage.body.nextCursor}`,
    );
    expect(secondPage.body.data).toHaveLength(1);
    expect(secondPage.body.data[0]?.category).toBe("utility");
    expect(secondPage.body.hasMore).toBe(false);
    expect(secondPage.body.nextCursor).toBeNull();
  });

  test("returns a well-formed empty envelope for no results and cursors past the end", async () => {
    const empty = await readList();
    expect(empty.response.status).toBe(200);
    expect(empty.body).toEqual({
      data: [],
      hasMore: false,
      nextCursor: null,
    });

    const baseTime = Date.parse("2026-01-05T00:00:00.000Z");
    for (let index = 0; index < 5; index += 1) {
      await createTemplate({
        id: `tmpl_test_empty_${String(index).padStart(3, "0")}`,
        createdAt: new Date(baseTime + index * 1000),
      });
    }

    const fullPage = await readList("/api/v2/agent-templates?limit=5");
    expect(fullPage.body.data).toHaveLength(5);
    expect(fullPage.body.hasMore).toBe(false);
    expect(fullPage.body.nextCursor).toBeNull();

    const pastEndCursor = encodeCursor({
      id: "tmpl_zzz",
      createdAt: "1970-01-01T00:00:00.000Z",
    });
    const pastEnd = await readList(
      `/api/v2/agent-templates?cursor=${pastEndCursor}`,
    );
    expect(pastEnd.body).toEqual({
      data: [],
      hasMore: false,
      nextCursor: null,
    });
  });
});
