/**
 * Cross-area auth flow tests (VAL-AUTH-CROSS-001..004)
 *
 * Tests that:
 *   - User A creates draft → User B cannot see/mutate; User A and API key listener can (VAL-AUTH-CROSS-001)
 *   - User A publishes → User B can see but cannot mutate (VAL-AUTH-CROSS-002)
 *   - Unauthenticated can list published but cannot filter by status or see drafts (VAL-AUTH-CROSS-003)
 *   - JWT-only user (no accountId) is rejected from write routes with 403 (VAL-AUTH-CROSS-004)
 */

import type { Server } from "node:http";
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

// ---------------------------------------------------------------------------
// Test account IDs
// ---------------------------------------------------------------------------

const USER_A_ID = ADMIN_ACCOUNT_ID;
const USER_B_ID = "11111111-2222-4333-4444-555555666667";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const validAgentAssetsApiKey =
  "test-agent-assets-api-key-that-is-at-least-32-characters";

const originalAgentAssetsApiKey = process.env.AGENT_ASSETS_API_KEY;

const jwtHeadersFor = async (accountId: string) => ({
  "Content-Type": "application/json",
  "X-Convos-AuthToken": await createJwtToken({
    deviceId: "test-device-auth-cross",
    accountId,
  }),
});

/** JWT without accountId — simulates JWT-only auth (no SIWE) */
const jwtOnlyHeaders = async () => ({
  "Content-Type": "application/json",
  "X-Convos-AuthToken": await createJwtToken({
    deviceId: "test-device-auth-cross-no-account",
    // No accountId
  }),
});

const agentKeyHeaders = () => ({
  "Content-Type": "application/json",
  "X-Agent-API-Key": validAgentAssetsApiKey,
});

let server: Server;
const baseURL = "http://localhost:4042";

const app = express();
app.use(pinoMiddleware);
app.use(jsonMiddleware);
app.use("/api/v2/agent-templates", agentTemplatesRouter);
app.use(noRouteMiddleware);

// ---------------------------------------------------------------------------
// DB setup / cleanup
// ---------------------------------------------------------------------------

const cleanupTestRows = async () => {
  await prisma.agentTemplate.deleteMany({
    where: {
      OR: [
        { slug: { startsWith: "cross-auth-" } },
        { agentName: { startsWith: "Cross Auth" } },
      ],
    },
  });
};

const ensureUserBAccount = async () => {
  const existing = await prisma.account.findUnique({
    where: { id: USER_B_ID },
  });
  if (!existing) {
    await prisma.account.create({ data: { id: USER_B_ID } });
  }
};

const deleteAccounts = async () => {
  try {
    await prisma.account.delete({ where: { id: USER_B_ID } });
  } catch {
    // Account may not exist
  }
};

// ---------------------------------------------------------------------------
// Test suites
// ---------------------------------------------------------------------------

describe("Cross-area auth flows", () => {
  beforeAll(async () => {
    process.env.AGENT_ASSETS_API_KEY = validAgentAssetsApiKey;
    await ensureUserBAccount();
    server = app.listen(4042);
  });

  afterAll(async () => {
    if (originalAgentAssetsApiKey === undefined) {
      delete process.env.AGENT_ASSETS_API_KEY;
    } else {
      process.env.AGENT_ASSETS_API_KEY = originalAgentAssetsApiKey;
    }
    server.close();
    await cleanupTestRows();
    await deleteAccounts();
  });

  beforeEach(async () => {
    process.env.AGENT_ASSETS_API_KEY = validAgentAssetsApiKey;
    await cleanupTestRows();
  });

  // VAL-AUTH-CROSS-001: User A creates draft → User B cannot see/mutate; User A and API key listener can
  test("User A creates draft — User B cannot see/mutate; User A and API key listener can", async () => {
    // Step 1: User A creates draft
    const createResponse = await fetch(`${baseURL}/api/v2/agent-templates`, {
      method: "POST",
      headers: await jwtHeadersFor(USER_A_ID),
      body: JSON.stringify({
        agentName: "Cross Auth Draft A",
        prompt: "A's draft",
        slug: "cross-auth-draft-a",
      }),
    });
    expect(createResponse.status).toBe(201);
    const createBody = (await createResponse.json()) as Record<string, unknown>;
    const templateId = createBody.id as string;

    // Step 2: User B cannot see it in list
    const bListResponse = await fetch(
      `${baseURL}/api/v2/agent-templates?limit=100`,
      { headers: await jwtHeadersFor(USER_B_ID) },
    );
    const bListBody = (await bListResponse.json()) as {
      data: Record<string, unknown>[];
    };
    expect(bListBody.data.some((t) => t.id === templateId)).toBe(false);

    // Step 3: User B cannot see it in detail — 404
    const bDetailResponse = await fetch(
      `${baseURL}/api/v2/agent-templates/${templateId}`,
      { headers: await jwtHeadersFor(USER_B_ID) },
    );
    expect(bDetailResponse.status).toBe(404);

    // Step 4: User B cannot PATCH — 403
    const bPatchResponse = await fetch(
      `${baseURL}/api/v2/agent-templates/${templateId}`,
      {
        method: "PATCH",
        headers: await jwtHeadersFor(USER_B_ID),
        body: JSON.stringify({ agentName: "Hacked by B" }),
      },
    );
    expect(bPatchResponse.status).toBe(403);

    // Step 5: User A can see it in list
    const aListResponse = await fetch(
      `${baseURL}/api/v2/agent-templates?limit=100`,
      { headers: await jwtHeadersFor(USER_A_ID) },
    );
    const aListBody = (await aListResponse.json()) as {
      data: Record<string, unknown>[];
    };
    expect(aListBody.data.some((t) => t.id === templateId)).toBe(true);

    // Step 6: User A can see it in detail
    const aDetailResponse = await fetch(
      `${baseURL}/api/v2/agent-templates/${templateId}`,
      { headers: await jwtHeadersFor(USER_A_ID) },
    );
    expect(aDetailResponse.status).toBe(200);

    // Step 7: User A can PATCH
    const aPatchResponse = await fetch(
      `${baseURL}/api/v2/agent-templates/${templateId}`,
      {
        method: "PATCH",
        headers: await jwtHeadersFor(USER_A_ID),
        body: JSON.stringify({ agentName: "Updated by A" }),
      },
    );
    expect(aPatchResponse.status).toBe(200);

    // Step 8: API key listener can see in detail
    const keyDetailResponse = await fetch(
      `${baseURL}/api/v2/agent-templates/${templateId}`,
      { headers: agentKeyHeaders() },
    );
    expect(keyDetailResponse.status).toBe(200);

    // Step 9: API key listener can PATCH
    const keyPatchResponse = await fetch(
      `${baseURL}/api/v2/agent-templates/${templateId}`,
      {
        method: "PATCH",
        headers: agentKeyHeaders(),
        body: JSON.stringify({ agentName: "Patched by API key" }),
      },
    );
    expect(keyPatchResponse.status).toBe(200);
  });

  // VAL-AUTH-CROSS-002: User A publishes → User B can see but cannot mutate
  test("User A publishes — User B can see but cannot mutate", async () => {
    // Step 1: User A creates and publishes
    const createResponse = await fetch(`${baseURL}/api/v2/agent-templates`, {
      method: "POST",
      headers: await jwtHeadersFor(USER_A_ID),
      body: JSON.stringify({
        agentName: "Cross Auth Pub A",
        prompt: "A's published",
        slug: "cross-auth-pub-a",
      }),
    });
    const createBody = (await createResponse.json()) as Record<string, unknown>;
    const templateId = createBody.id as string;

    await fetch(`${baseURL}/api/v2/agent-templates/${templateId}/publish`, {
      method: "POST",
      headers: await jwtHeadersFor(USER_A_ID),
    });

    // Step 2: User B can see it in list
    const bListResponse = await fetch(
      `${baseURL}/api/v2/agent-templates?limit=100`,
      { headers: await jwtHeadersFor(USER_B_ID) },
    );
    const bListBody = (await bListResponse.json()) as {
      data: Record<string, unknown>[];
    };
    expect(bListBody.data.some((t) => t.id === templateId)).toBe(true);

    // Step 3: User B can see it in detail
    const bDetailResponse = await fetch(
      `${baseURL}/api/v2/agent-templates/${templateId}`,
      { headers: await jwtHeadersFor(USER_B_ID) },
    );
    expect(bDetailResponse.status).toBe(200);

    // Step 4: User B cannot PATCH
    const bPatchResponse = await fetch(
      `${baseURL}/api/v2/agent-templates/${templateId}`,
      {
        method: "PATCH",
        headers: await jwtHeadersFor(USER_B_ID),
        body: JSON.stringify({ agentName: "Hacked by B" }),
      },
    );
    expect(bPatchResponse.status).toBe(403);

    // Step 5: User B cannot DELETE
    const bDeleteResponse = await fetch(
      `${baseURL}/api/v2/agent-templates/${templateId}`,
      {
        method: "DELETE",
        headers: await jwtHeadersFor(USER_B_ID),
      },
    );
    expect(bDeleteResponse.status).toBe(403);

    // Step 6: User B cannot PUBLISH (re-publish)
    const bPublishResponse = await fetch(
      `${baseURL}/api/v2/agent-templates/${templateId}/publish`,
      {
        method: "POST",
        headers: await jwtHeadersFor(USER_B_ID),
      },
    );
    expect(bPublishResponse.status).toBe(403);
  });

  // VAL-AUTH-CROSS-003: Unauthenticated can list published but cannot filter by status or see drafts
  test("Unauthenticated can list published templates but cannot filter by status or see drafts", async () => {
    // Create and publish a template
    const createResponse = await fetch(`${baseURL}/api/v2/agent-templates`, {
      method: "POST",
      headers: agentKeyHeaders(),
      body: JSON.stringify({
        agentName: "Cross Auth Unauth Pub",
        prompt: "Published",
        slug: "cross-auth-unauth-pub",
      }),
    });
    const createBody = (await createResponse.json()) as Record<string, unknown>;
    const pubId = createBody.id as string;

    await fetch(`${baseURL}/api/v2/agent-templates/${pubId}/publish`, {
      method: "POST",
      headers: agentKeyHeaders(),
    });

    // Create a draft
    const draftResponse = await fetch(`${baseURL}/api/v2/agent-templates`, {
      method: "POST",
      headers: agentKeyHeaders(),
      body: JSON.stringify({
        agentName: "Cross Auth Unauth Draft",
        prompt: "Draft",
        slug: "cross-auth-unauth-draft",
      }),
    });
    const draftBody = (await draftResponse.json()) as Record<string, unknown>;
    const draftId = draftBody.id as string;

    // (1) Unauthenticated GET list — all templates have status: published
    const listResponse = await fetch(
      `${baseURL}/api/v2/agent-templates?limit=100`,
    );
    expect(listResponse.status).toBe(200);
    const listBody = (await listResponse.json()) as {
      data: Record<string, unknown>[];
    };
    const allPublished = listBody.data.every((t) => t.status === "published");
    expect(allPublished).toBe(true);
    expect(listBody.data.some((t) => t.id === draftId)).toBe(false);

    // (2) Unauthenticated GET ?status=draft — 400
    const statusFilterResponse = await fetch(
      `${baseURL}/api/v2/agent-templates?status=draft`,
    );
    expect(statusFilterResponse.status).toBe(400);

    // (3) Unauthenticated GET detail for draft — 404
    const draftDetailResponse = await fetch(
      `${baseURL}/api/v2/agent-templates/${draftId}`,
    );
    expect(draftDetailResponse.status).toBe(404);
  });

  // VAL-AUTH-CROSS-004: JWT-only user (no accountId) is rejected from write routes with 403
  test("JWT-only user (no accountId) is rejected from write routes", async () => {
    // POST /agent-templates
    const postResponse = await fetch(`${baseURL}/api/v2/agent-templates`, {
      method: "POST",
      headers: await jwtOnlyHeaders(),
      body: JSON.stringify({
        agentName: "Cross Auth No Account",
        prompt: "Should not persist",
        slug: "cross-auth-no-account",
      }),
    });
    expect(postResponse.status).toBe(403);

    // PATCH /agent-templates/:id
    const patchResponse = await fetch(
      `${baseURL}/api/v2/agent-templates/tmpl_fake`,
      {
        method: "PATCH",
        headers: await jwtOnlyHeaders(),
        body: JSON.stringify({ agentName: "Hacked" }),
      },
    );
    expect(patchResponse.status).toBe(403);

    // DELETE /agent-templates/:id
    const deleteResponse = await fetch(
      `${baseURL}/api/v2/agent-templates/tmpl_fake`,
      {
        method: "DELETE",
        headers: await jwtOnlyHeaders(),
      },
    );
    expect(deleteResponse.status).toBe(403);

    // POST /agent-templates/:id/publish
    const publishResponse = await fetch(
      `${baseURL}/api/v2/agent-templates/tmpl_fake/publish`,
      {
        method: "POST",
        headers: await jwtOnlyHeaders(),
      },
    );
    expect(publishResponse.status).toBe(403);

    // POST /agent-templates/generate
    // NOTE: The generate route doesn't exist on this branch (feat/agent-templates-crud).
    // This assertion will be covered on feat/agent-templates-create-job when it
    // incorporates these ownership changes. The requireAccount guard already
    // applies to the generate route on that branch.
  });
});
