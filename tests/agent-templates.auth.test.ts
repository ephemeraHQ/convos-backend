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
} from "bun:test";
import { __setAgentAssetsApiKeyOverrideForTests } from "@/middleware/agentAuth";
import { ADMIN_ACCOUNT_ID } from "@/utils/constants";
import { createJwtToken } from "@/utils/jwt";
import { prisma } from "@/utils/prisma";
import { buildAgentTemplatesApp } from "./agent-templates.cross.helpers";

type TemplateBody = Record<string, unknown>;
type RequestHeaders = Record<string, string>;

const app = buildAgentTemplatesApp();

let server: Server;
const baseURL = "http://localhost:4067";
const validAgentAssetsApiKey =
  "test-agent-assets-api-key-that-is-at-least-32-characters";
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
        { slug: { startsWith: "auth-test-" } },
        { agentName: { startsWith: "Auth Test" } },
      ],
    },
  });
  testTemplateIds.length = 0;
};

const restoreAgentAssetsApiKey = () => {
  __setAgentAssetsApiKeyOverrideForTests(undefined);
};

const jwtHeaders = async (token?: string) => ({
  "Content-Type": "application/json",
  "X-Convos-AuthToken":
    token ??
    (await createJwtToken({
      deviceId: "test-device-agent-templates-auth",
      accountId: ADMIN_ACCOUNT_ID,
    })),
});

const agentKeyHeaders = ({
  headerName = "X-Agent-API-Key",
  key = validAgentAssetsApiKey,
}: {
  headerName?: string;
  key?: string;
} = {}) => ({
  "Content-Type": "application/json",
  [headerName]: key,
});

const bothHeaders = ({
  agentKey = validAgentAssetsApiKey,
  jwt = "malformed.jwt.token",
}: {
  agentKey?: string;
  jwt?: string;
} = {}) => ({
  ...agentKeyHeaders({ key: agentKey }),
  "X-Convos-AuthToken": jwt,
});

const seedTemplate = async (
  label: string,
  kind: string,
  overrides: Partial<Prisma.AgentTemplateUncheckedCreateInput> = {},
) => {
  const id = randomUUID();
  testTemplateIds.push(id);
  return prisma.agentTemplate.create({
    data: {
      id,
      slug: `auth-test-${label}-${kind}`,
      ownerAccountId: ADMIN_ACCOUNT_ID,
      forkedFromId: null,
      agentName: `Auth Test ${label} ${kind}`,
      description: `initial ${kind}`,
      prompt: `Initial prompt for ${label} ${kind}`,
      category: null,
      emoji: null,
      avatarUrl: null,
      tools: [],
      connections: [],
      version: 1,
      firstPublishedAt: null,
      status: "draft",
      featured: false,
      createdAt,
      ...overrides,
    },
  });
};

const postTemplate = async (
  label: string,
  headers: RequestHeaders,
  slug = `auth-test-${label}-create`,
) =>
  fetch(`${baseURL}/api/v2/agent-templates`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      agentName: `Auth Test ${label} Create`,
      prompt: `Prompt for ${label}`,
      slug,
    }),
  });

const patchTemplate = async (id: string, headers: RequestHeaders) =>
  fetch(`${baseURL}/api/v2/agent-templates/${id}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ description: "patched by auth test" }),
  });

const deleteTemplate = async (id: string, headers: RequestHeaders) =>
  fetch(`${baseURL}/api/v2/agent-templates/${id}`, {
    method: "DELETE",
    headers,
  });

const publishTemplate = async (id: string, headers: RequestHeaders) =>
  fetch(`${baseURL}/api/v2/agent-templates/${id}/publish`, {
    method: "POST",
    headers,
  });

const exerciseAllWrites = async (label: string, headers: RequestHeaders) => {
  const patchRow = await seedTemplate(label, "patch");
  const deleteRow = await seedTemplate(label, "delete");
  const publishRow = await seedTemplate(label, "publish");

  const create = await postTemplate(label, headers);
  const patch = await patchTemplate(patchRow.id, headers);
  const del = await deleteTemplate(deleteRow.id, headers);
  const publish = await publishTemplate(publishRow.id, headers);

  return { create, patch, del, publish, patchRow, deleteRow, publishRow };
};

const expectNoMutationAfterRejectedWrites = async (args: {
  label: string;
  patchRowId: string;
  deleteRowId: string;
  publishRowId: string;
}) => {
  expect(
    await prisma.agentTemplate.count({
      where: { slug: `auth-test-${args.label}-create` },
    }),
  ).toBe(0);

  const patchRow = await prisma.agentTemplate.findUniqueOrThrow({
    where: { id: args.patchRowId },
  });
  expect(patchRow.description).toBe("initial patch");

  expect(
    await prisma.agentTemplate.count({ where: { id: args.deleteRowId } }),
  ).toBe(1);

  const publishRow = await prisma.agentTemplate.findUniqueOrThrow({
    where: { id: args.publishRowId },
  });
  expect(publishRow.status).toBe("draft");
  expect(publishRow.firstPublishedAt).toBeNull();
};

describe("Agent template write auth", () => {
  beforeAll(async () => {
    await new Promise<void>((resolve) => {
      server = app.listen(4067, () => {
        resolve();
      });
    });
  });

  afterAll(async () => {
    restoreAgentAssetsApiKey();
    await cleanupTemplates();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  });

  beforeEach(async () => {
    __setAgentAssetsApiKeyOverrideForTests(validAgentAssetsApiKey);
    await cleanupTemplates();
  });

  test("rejects every write without auth and leaves rows unchanged", async () => {
    const label = "missing";
    const { create, patch, del, publish, patchRow, deleteRow, publishRow } =
      await exerciseAllWrites(label, { "Content-Type": "application/json" });

    expect([create.status, patch.status, del.status, publish.status]).toEqual([
      401, 401, 401, 401,
    ]);
    await expectNoMutationAfterRejectedWrites({
      label,
      patchRowId: patchRow.id,
      deleteRowId: deleteRow.id,
      publishRowId: publishRow.id,
    });
  });

  test("accepts a valid JWT on all write endpoints", async () => {
    const label = "jwt";
    const { create, patch, del, publish, patchRow, deleteRow, publishRow } =
      await exerciseAllWrites(label, await jwtHeaders());

    expect([create.status, patch.status, del.status, publish.status]).toEqual([
      201, 200, 200, 200,
    ]);

    const createBody = (await create.json()) as TemplateBody;
    expect(createBody.ownerAccountId).toBe(ADMIN_ACCOUNT_ID);

    const patched = await prisma.agentTemplate.findUniqueOrThrow({
      where: { id: patchRow.id },
    });
    expect(patched.description).toBe("patched by auth test");
    expect(
      await prisma.agentTemplate.count({ where: { id: deleteRow.id } }),
    ).toBe(0);
    const published = await prisma.agentTemplate.findUniqueOrThrow({
      where: { id: publishRow.id },
    });
    expect(published.status).toBe("published");
    expect(published.firstPublishedAt).not.toBeNull();
  });

  test("accepts a valid X-Agent-API-Key on all write endpoints", async () => {
    const label = "agent-key";
    const { create, patch, del, publish } = await exerciseAllWrites(
      label,
      agentKeyHeaders(),
    );

    expect([create.status, patch.status, del.status, publish.status]).toEqual([
      201, 200, 200, 200,
    ]);
  });

  test("does not fall back to JWT when an invalid agent key header is present", async () => {
    const label = "invalid-agent-key";
    const response = await postTemplate(
      label,
      bothHeaders({
        agentKey: "wrong-value",
        jwt: (await jwtHeaders())["X-Convos-AuthToken"],
      }),
    );
    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(401);
    expect(body.error).toContain("Invalid or missing agent API key");
    expect(
      await prisma.agentTemplate.count({
        where: { slug: `auth-test-${label}-create` },
      }),
    ).toBe(0);
  });

  test("lets a valid agent key win even when the JWT header is malformed", async () => {
    const label = "both-agent-wins";
    const response = await postTemplate(label, bothHeaders());
    const body = (await response.json()) as TemplateBody;

    expect(response.status).toBe(201);
    expect(body.slug).toBe(`auth-test-${label}-create`);
  });

  test("returns 503 on the agent-key path when the configured key is unset or too short", async () => {
    __setAgentAssetsApiKeyOverrideForTests("");
    const unset = await postTemplate("unset-key", agentKeyHeaders());
    expect(unset.status).toBe(503);
    expect(await unset.json()).toEqual({
      error: "Agent assets API key not configured",
    });

    __setAgentAssetsApiKeyOverrideForTests("too-short");
    const short = await postTemplate("short-key", agentKeyHeaders());
    expect(short.status).toBe(503);
    expect(await short.json()).toEqual({
      error: "Agent assets API key not configured",
    });
  });

  test("rejects malformed JWT-only requests on all write endpoints without mutations", async () => {
    const label = "malformed-jwt";
    const { create, patch, del, publish, patchRow, deleteRow, publishRow } =
      await exerciseAllWrites(label, await jwtHeaders("not-a-real-jwt"));

    expect([create.status, patch.status, del.status, publish.status]).toEqual([
      401, 401, 401, 401,
    ]);
    await expectNoMutationAfterRejectedWrites({
      label,
      patchRowId: patchRow.id,
      deleteRowId: deleteRow.id,
      publishRowId: publishRow.id,
    });
  });

  test("matches X-Agent-API-Key header names case-insensitively", async () => {
    const cases = [
      { label: "lowercase", headerName: "x-agent-api-key" },
      { label: "uppercase", headerName: "X-AGENT-API-KEY" },
      { label: "mixedcase", headerName: "X-Agent-Api-Key" },
    ];

    for (const headerCase of cases) {
      const response = await postTemplate(
        `header-${headerCase.label}`,
        agentKeyHeaders({ headerName: headerCase.headerName }),
      );
      expect(response.status).toBe(201);
    }

    expect(
      await prisma.agentTemplate.count({
        where: { slug: { startsWith: "auth-test-header-" } },
      }),
    ).toBe(3);
  });
});
