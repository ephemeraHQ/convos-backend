import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AgentTemplate, Prisma } from "@prisma/client";
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

type ListEnvelope = {
  data: Array<Record<string, unknown>>;
  hasMore: boolean;
  nextCursor: string | null;
};

const app = buildAgentTemplatesApp();

let server: Server;
const baseURL = "http://localhost:4052";

const cleanupTemplates = () =>
  prisma.agentTemplate.deleteMany({
    where: { ownerAccountId: ADMIN_ACCOUNT_ID },
  });

// Mirrors the handler's cursor payload: `s` = sort field, `o` = order, `v` =
// the sort field's value on the last row (plus `id` as the tiebreaker).
const encodeCursor = (cursor: {
  id: string;
  s: string;
  o: "asc" | "desc";
  v: string;
}) => Buffer.from(JSON.stringify(cursor)).toString("base64url");

// Use a distinct, non-admin account so visibility semantics match the
// pre-auth-required tests: the caller is NOT the template owner, so they
// see only published templates owned by ADMIN.
const READER_ACCOUNT_ID = "00000000-0000-4000-8000-000000000001";

const readerAuthHeaders = async (): Promise<Record<string, string>> => {
  // Fail-closed auth: a JWT accountId claim must reference a live Account
  // row, so the synthetic reader account has to exist.
  await prisma.account.upsert({
    where: { id: READER_ACCOUNT_ID },
    update: {},
    create: { id: READER_ACCOUNT_ID },
  });
  return {
    "X-Convos-AuthToken": await createJwtToken({
      deviceId: "test-device-agent-templates-list",
      accountId: READER_ACCOUNT_ID,
    }),
  };
};

const readList = async (path = "/api/v2/agent-templates") => {
  const response = await fetch(`${baseURL}${path}`, {
    headers: await readerAuthHeaders(),
  });
  const body = (await response.json()) as ListEnvelope;

  return { body, response };
};

const createTemplate = async (
  overrides: Partial<Prisma.AgentTemplateUncheckedCreateInput> = {},
) => {
  const id = overrides.id ?? randomUUID();
  const slug = overrides.slug ?? `test-${id.slice(0, 8)}`;

  return prisma.agentTemplate.create({
    data: {
      id,
      slug,
      ownerAccountId: overrides.ownerAccountId ?? ADMIN_ACCOUNT_ID,
      forkedFromId: overrides.forkedFromId ?? null,
      agentName: overrides.agentName ?? `Template ${id}`,
      description: overrides.description ?? null,
      prompt: overrides.prompt ?? `Prompt for ${id}`,
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
      server = app.listen(4052, () => {
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
    const tmpl = await createTemplate();

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
      id: tmpl.id,
      ownerAccountId: ADMIN_ACCOUNT_ID,
      status: "published",
    });
    expect(body.data[0]?.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(body.data[0]).not.toHaveProperty("updatedAt");

    // Independent authed call (token minted inline) returns the same shape
    // and data as the helper.
    const authToken = await createJwtToken({
      deviceId: "test-device-agent-templates-list",
      accountId: READER_ACCOUNT_ID,
    });
    const authedResponse = await fetch(`${baseURL}/api/v2/agent-templates`, {
      headers: { "X-Convos-AuthToken": authToken },
    });
    const authedBody = (await authedResponse.json()) as ListEnvelope;
    expect(authedResponse.status).toBe(200);
    expect(ids(authedBody.data)).toEqual(ids(body.data));

    // Snake-cased path stays unmounted — no router matches → 404 from
    // noRouteMiddleware before any auth middleware runs.
    const snakeResponse = await fetch(`${baseURL}/api/v2/agent_templates`);
    expect(snakeResponse.status).toBe(404);
  });

  test("omits non-published rows and composes category owner and featured filters", async () => {
    await createTemplate({
      status: "draft",
      category: "utility",
      featured: true,
    });
    const tmplPubFeatured = await createTemplate({
      status: "published",
      category: "utility",
      featured: true,
    });
    const tmplPubPlain = await createTemplate({
      status: "published",
      category: "entertainment",
      featured: false,
    });
    await createTemplate({
      status: "unlisted",
      category: "utility",
      featured: true,
    });
    await createTemplate({
      status: "archived",
      category: "utility",
      featured: true,
    });

    const defaultList = await readList();
    expect(defaultList.response.status).toBe(200);
    expect(ids(defaultList.body.data).sort()).toEqual(
      [tmplPubFeatured.id, tmplPubPlain.id].sort(),
    );

    const utility = await readList("/api/v2/agent-templates?category=utility");
    expect(ids(utility.body.data)).toEqual([tmplPubFeatured.id]);

    const entertainment = await readList(
      "/api/v2/agent-templates?category=entertainment",
    );
    expect(ids(entertainment.body.data)).toEqual([tmplPubPlain.id]);

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
      "/api/v2/agent-templates?owner=00000000-0000-0000-0000-000000000000",
    );
    expect(missingOwner.body).toEqual({
      data: [],
      hasMore: false,
      nextCursor: null,
    });

    const featured = await readList("/api/v2/agent-templates?featured=true");
    expect(ids(featured.body.data)).toEqual([tmplPubFeatured.id]);

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
    expect(ids(composed.body.data)).toEqual([tmplPubFeatured.id]);
  });

  test("rejects invalid status values, invalid limits, and malformed cursors with 400", async () => {
    const headers = await readerAuthHeaders();

    // Valid enum values are accepted (200); only unknown / empty strings 400.
    for (const status of ["draft", "published", "unlisted", "archived"]) {
      const response = await fetch(
        `${baseURL}/api/v2/agent-templates?status=${status}`,
        { headers },
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain(
        "application/json",
      );
    }
    for (const status of ["anything", ""]) {
      const response = await fetch(
        `${baseURL}/api/v2/agent-templates?status=${status}`,
        { headers },
      );
      expect(response.status).toBe(400);
      expect(response.headers.get("content-type")).toContain(
        "application/json",
      );
    }

    for (const limit of ["0", "-1", "abc", "1.5"]) {
      const response = await fetch(
        `${baseURL}/api/v2/agent-templates?limit=${limit}`,
        { headers },
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
        { headers },
      );
      expect(response.status).toBe(400);
    }
  });

  test("orders by createdAt descending then id descending", async () => {
    const tieCreatedAt = new Date("2026-01-01T00:00:00.000Z");
    const [_older, _newer, tieA, tieB] = await Promise.all([
      createTemplate({
        createdAt: new Date("2025-12-31T23:59:58.000Z"),
      }),
      createTemplate({
        createdAt: new Date("2025-12-31T23:59:59.000Z"),
      }),
      createTemplate({
        createdAt: tieCreatedAt,
      }),
      createTemplate({
        createdAt: tieCreatedAt,
      }),
    ]);

    const { body } = await readList();

    // tieB and tieA: tieB.id > tieA.id because UUIDs sort lexicographically
    // We just verify the ordering rules: createdAt desc, then id desc
    expect(body.data).toHaveLength(4);
    const resultIds = ids(body.data);
    // Newer timestamps first
    expect(
      new Date(body.data[0]?.createdAt as string).getTime(),
    ).toBeGreaterThanOrEqual(
      new Date(body.data[1]?.createdAt as string).getTime(),
    );
    // The two tied ones should be adjacent
    const tiedStartIdx = resultIds.findIndex(
      (id) => id === tieA.id || id === tieB.id,
    );
    expect(
      [resultIds[tiedStartIdx], resultIds[tiedStartIdx + 1]].sort().reverse(),
    ).toEqual([tieB.id, tieA.id].sort().reverse());
  });

  test("uses default limit 20, clamps to 100, and returns cursor echoing the last row", async () => {
    const baseTime = Date.parse("2026-01-02T00:00:00.000Z");
    const rows: AgentTemplate[] = [];

    for (let index = 0; index < 120; index += 1) {
      rows.push(
        await createTemplate({
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
    ) as { id: string; s: string; o: string; v: string };
    expect(decodedDefaultCursor.id).toBe(lastDefaultRow.id);
    expect(decodedDefaultCursor.s).toBe("createdAt");
    expect(decodedDefaultCursor.o).toBe("desc");
    expect(decodedDefaultCursor.v).toBe(lastDefaultRow.createdAt);

    const clamped = await readList("/api/v2/agent-templates?limit=200");
    expect(clamped.body.data).toHaveLength(100);
    expect(clamped.body.hasMore).toBe(true);

    const explicitMax = await readList("/api/v2/agent-templates?limit=100");
    expect(explicitMax.body.data).toHaveLength(100);
  });

  test("round-trips a keyset cursor without duplicates or skips", async () => {
    const baseTime = Date.parse("2026-01-03T00:00:00.000Z");

    const created: string[] = [];
    for (let index = 0; index < 25; index += 1) {
      const tmpl = await createTemplate({
        createdAt: new Date(baseTime + index * 1000),
      });
      created.push(tmpl.id);
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

    expect([...firstIds].some((id) => secondIds.has(id as string))).toBe(false);
    expect(allIds).toEqual(new Set(created));
  });

  test("applies cursors inside active filters", async () => {
    const baseTime = Date.parse("2026-01-04T00:00:00.000Z");

    for (let index = 0; index < 21; index += 1) {
      await createTemplate({
        category: "utility",
        createdAt: new Date(baseTime + index * 1000),
      });
    }

    for (let index = 0; index < 5; index += 1) {
      await createTemplate({
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
        createdAt: new Date(baseTime + index * 1000),
      });
    }

    const fullPage = await readList("/api/v2/agent-templates?limit=5");
    expect(fullPage.body.data).toHaveLength(5);
    expect(fullPage.body.hasMore).toBe(false);
    expect(fullPage.body.nextCursor).toBeNull();

    const pastEndCursor = encodeCursor({
      id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      s: "createdAt",
      o: "desc",
      v: "1970-01-01T00:00:00.000Z",
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
