import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import express from "express";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";
import { agentPromptHintsRouter } from "@/api/v2/agent-prompt-hints/agent-prompt-hints.router";
import { __setAgentAssetsApiKeyOverrideForTests } from "@/middleware/agentAuth";
import { jsonMiddleware } from "@/middleware/json";
import { noRouteMiddleware } from "@/middleware/noRoute";
import { pinoMiddleware } from "@/middleware/pino";
import { ADMIN_ACCOUNT_ID } from "@/utils/constants";
import { createJwtToken } from "@/utils/jwt";
import { prisma } from "@/utils/prisma";

type AdminRow = {
  id: string;
  text: string;
  published: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
};
type AdminEnvelope = { data: AdminRow[] };
type HintsEnvelope = { hints: string[] };

// All fixture rows carry this prefix so cleanup and assertions only ever touch
// test data, never the curated seed rows in the shared local database.
const TEST_PREFIX = "__hint_admin_test__";

const validAgentAssetsApiKey =
  "test-agent-assets-api-key-that-is-at-least-32-characters";

const agentKeyHeaders = (): Record<string, string> => ({
  "Content-Type": "application/json",
  "X-Agent-API-Key": validAgentAssetsApiKey,
});

const jsonHeaders: Record<string, string> = {
  "Content-Type": "application/json",
};

// JWT-authed headers for an account. Used to prove the admin gate: a non-admin
// account is rejected (403), while the admin account's own JWT is accepted -
// the same admin identity the agent-templates admin tests authenticate with.
const jwtHeaders = async (
  accountId: string,
): Promise<Record<string, string>> => ({
  "Content-Type": "application/json",
  "X-Convos-AuthToken": await createJwtToken({
    deviceId: "test-device-hint-admin-gate",
    accountId,
  }),
});

const buildApp = (): express.Express => {
  const app = express();
  app.use(pinoMiddleware);
  app.use(jsonMiddleware);
  app.use("/api/v2/agent-prompt-hints", agentPromptHintsRouter);
  app.use(noRouteMiddleware);
  return app;
};

const app = buildApp();
let server: Server;
// Bind to an ephemeral port (0) and read the assigned port back at runtime so
// concurrent vitest workers never collide on a fixed port (EADDRINUSE).
let baseURL = "";

const cleanup = () =>
  prisma.agentPromptHint.deleteMany({
    where: { text: { startsWith: TEST_PREFIX } },
  });

const seedHint = (args: {
  text: string;
  published?: boolean;
  sortOrder?: number;
}) =>
  prisma.agentPromptHint.create({
    data: {
      text: args.text,
      published: args.published ?? true,
      sortOrder: args.sortOrder ?? 0,
    },
  });

// A fixed-length string (incl. the test prefix) so length-boundary assertions
// are exact under the 240-char cap.
const textOfLength = (length: number, label: string) => {
  const head = `${TEST_PREFIX}${label}:`;
  return head + "x".repeat(Math.max(0, length - head.length));
};

const createHint = async (
  body: Record<string, unknown>,
  headers: Record<string, string> = agentKeyHeaders(),
) => {
  const response = await fetch(`${baseURL}/api/v2/agent-prompt-hints`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const json = (await response.json()) as AdminRow & { error?: unknown };
  return { response, json };
};

const patchHint = async (
  id: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = agentKeyHeaders(),
) => {
  const response = await fetch(`${baseURL}/api/v2/agent-prompt-hints/${id}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify(body),
  });
  const json = (await response.json()) as AdminRow & { error?: unknown };
  return { response, json };
};

const deleteHint = async (
  id: string,
  headers: Record<string, string> = agentKeyHeaders(),
) => {
  const response = await fetch(`${baseURL}/api/v2/agent-prompt-hints/${id}`, {
    method: "DELETE",
    headers,
  });
  const json = (await response.json()) as {
    id?: string;
    deleted?: boolean;
    error?: unknown;
  };
  return { response, json };
};

const listAdmin = async (
  headers: Record<string, string> = agentKeyHeaders(),
) => {
  const response = await fetch(`${baseURL}/api/v2/agent-prompt-hints/admin`, {
    headers,
  });
  const json = (await response.json()) as AdminEnvelope;
  return { response, json };
};

const adminTestRows = (json: AdminEnvelope): AdminRow[] =>
  json.data.filter((row) => row.text.startsWith(TEST_PREFIX));

const readPublicHints = async () => {
  const response = await fetch(`${baseURL}/api/v2/agent-prompt-hints`);
  const json = (await response.json()) as HintsEnvelope;
  return { response, hints: json.hints };
};

describe("Agent prompt hints admin endpoints", () => {
  beforeAll(async () => {
    __setAgentAssetsApiKeyOverrideForTests(validAgentAssetsApiKey);
    await new Promise<void>((resolve, reject) => {
      server = app.listen(0, () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          reject(new Error("Unable to determine server port"));
          return;
        }
        baseURL = `http://localhost:${address.port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await cleanup();
    __setAgentAssetsApiKeyOverrideForTests(undefined);
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  });

  beforeEach(async () => {
    await cleanup();
  });

  test("POST / creates a hint and returns the full row (201)", async () => {
    const text = `${TEST_PREFIX}create`;
    const { response, json } = await createHint({ text, sortOrder: 7 });

    expect(response.status).toBe(201);
    expect(typeof json.id).toBe("string");
    expect(json.text).toBe(text);
    expect(json.published).toBe(true);
    expect(json.sortOrder).toBe(7);
    expect(typeof json.createdAt).toBe("string");
    expect(typeof json.updatedAt).toBe("string");
  });

  test("POST / honours published:false", async () => {
    const text = `${TEST_PREFIX}create-unpublished`;
    const { response, json } = await createHint({ text, published: false });

    expect(response.status).toBe(201);
    expect(json.published).toBe(false);
  });

  test("GET /admin returns all rows incl. unpublished, ordered", async () => {
    const published = `${TEST_PREFIX}admin-published`;
    const unpublished = `${TEST_PREFIX}admin-unpublished`;
    await seedHint({ text: unpublished, published: false, sortOrder: 20 });
    await seedHint({ text: published, published: true, sortOrder: 10 });

    const { response, json } = await listAdmin();
    expect(response.status).toBe(200);

    const rows = adminTestRows(json);
    expect(rows.map((row) => row.text)).toEqual([published, unpublished]);
    // The unpublished row must be present (hidden from public, visible here).
    expect(rows.some((row) => row.text === unpublished && !row.published)).toBe(
      true,
    );
    // Full row shape.
    const first = rows[0];
    expect(Object.keys(first).sort()).toEqual(
      ["createdAt", "id", "published", "sortOrder", "text", "updatedAt"].sort(),
    );
  });

  test("PATCH /:id updates text, published, and sortOrder", async () => {
    const created = await createHint({ text: `${TEST_PREFIX}patch-src` });
    const id = created.json.id;

    const newText = `${TEST_PREFIX}patch-dst`;
    const { response, json } = await patchHint(id, {
      text: newText,
      published: false,
      sortOrder: 99,
    });

    expect(response.status).toBe(200);
    expect(json.text).toBe(newText);
    expect(json.published).toBe(false);
    expect(json.sortOrder).toBe(99);

    // Persisted, not just echoed.
    const persisted = await prisma.agentPromptHint.findUnique({
      where: { id },
    });
    expect(persisted?.text).toBe(newText);
    expect(persisted?.published).toBe(false);
    expect(persisted?.sortOrder).toBe(99);
  });

  test("PATCH /:id on a missing row returns 404", async () => {
    const { response } = await patchHint(
      "00000000-0000-4000-8000-000000000000",
      { published: false },
    );
    expect(response.status).toBe(404);
  });

  test("DELETE /:id removes the row and returns deleted:true", async () => {
    const created = await createHint({ text: `${TEST_PREFIX}delete-me` });
    const id = created.json.id;

    const { response, json } = await deleteHint(id);
    expect(response.status).toBe(200);
    expect(json).toEqual({
      object: "agent_prompt_hint",
      id,
      deleted: true,
    });

    const gone = await prisma.agentPromptHint.findUnique({ where: { id } });
    expect(gone).toBeNull();
  });

  test("DELETE /:id on a missing row returns 404", async () => {
    const { response } = await deleteHint(
      "00000000-0000-4000-8000-000000000000",
    );
    expect(response.status).toBe(404);
  });

  test("anonymous writes are rejected (401), and no row is created", async () => {
    const text = `${TEST_PREFIX}anon`;
    const { response } = await createHint({ text }, jsonHeaders);
    expect(response.status).toBe(401);

    const count = await prisma.agentPromptHint.count({ where: { text } });
    expect(count).toBe(0);

    // Anonymous GET /admin is gated too.
    const adminAnon = await fetch(`${baseURL}/api/v2/agent-prompt-hints/admin`);
    expect(adminAnon.status).toBe(401);
  });

  test("non-admin authenticated account is rejected (403), and no row is created", async () => {
    const headers = await jwtHeaders(randomUUID());

    // Write route (POST /) is admin-gated.
    const text = `${TEST_PREFIX}non-admin`;
    const { response } = await createHint({ text }, headers);
    expect(response.status).toBe(403);

    const count = await prisma.agentPromptHint.count({ where: { text } });
    expect(count).toBe(0);

    // Admin read route (GET /admin) is admin-gated too.
    const adminList = await listAdmin(headers);
    expect(adminList.response.status).toBe(403);
  });

  test("admin account's own JWT passes the admin gate (201)", async () => {
    const headers = await jwtHeaders(ADMIN_ACCOUNT_ID);
    const text = `${TEST_PREFIX}admin-jwt`;
    const { response, json } = await createHint({ text }, headers);
    expect(response.status).toBe(201);
    expect(json.text).toBe(text);
  });

  test("create rejects text longer than 240 chars (400)", async () => {
    const overLimit = textOfLength(241, "over");
    expect(overLimit.length).toBe(241);

    const { response } = await createHint({ text: overLimit });
    expect(response.status).toBe(400);

    const count = await prisma.agentPromptHint.count({
      where: { text: overLimit },
    });
    expect(count).toBe(0);
  });

  test("create accepts text of exactly 240 chars (201)", async () => {
    const atLimit = textOfLength(240, "limit");
    expect(atLimit.length).toBe(240);

    const { response } = await createHint({ text: atLimit });
    expect(response.status).toBe(201);
  });

  test("patch rejects text longer than 240 chars (400)", async () => {
    const created = await createHint({ text: `${TEST_PREFIX}patch-cap` });
    const overLimit = textOfLength(241, "patchover");

    const { response } = await patchHint(created.json.id, { text: overLimit });
    expect(response.status).toBe(400);
  });

  test("unpublished rows are hidden from public GET / but present in GET /admin", async () => {
    const published = `${TEST_PREFIX}visible`;
    const unpublished = `${TEST_PREFIX}hidden`;
    await createHint({ text: published, published: true, sortOrder: 1 });
    await createHint({ text: unpublished, published: false, sortOrder: 2 });

    const publicView = await readPublicHints();
    expect(publicView.response.status).toBe(200);
    expect(publicView.hints).toContain(published);
    expect(publicView.hints).not.toContain(unpublished);

    const adminView = await listAdmin();
    const texts = adminTestRows(adminView.json).map((row) => row.text);
    expect(texts).toContain(published);
    expect(texts).toContain(unpublished);
  });

  test("POST /reorder applies sortOrder atomically", async () => {
    const a = await createHint({
      text: `${TEST_PREFIX}reorder-a`,
      sortOrder: 1,
    });
    const b = await createHint({
      text: `${TEST_PREFIX}reorder-b`,
      sortOrder: 2,
    });

    const response = await fetch(
      `${baseURL}/api/v2/agent-prompt-hints/reorder`,
      {
        method: "POST",
        headers: agentKeyHeaders(),
        body: JSON.stringify({
          orders: [
            { id: a.json.id, sortOrder: 50 },
            { id: b.json.id, sortOrder: 40 },
          ],
        }),
      },
    );
    const json = (await response.json()) as { updated: number };
    expect(response.status).toBe(200);
    expect(json.updated).toBe(2);

    const rowA = await prisma.agentPromptHint.findUnique({
      where: { id: a.json.id },
    });
    const rowB = await prisma.agentPromptHint.findUnique({
      where: { id: b.json.id },
    });
    expect(rowA?.sortOrder).toBe(50);
    expect(rowB?.sortOrder).toBe(40);
  });
});
