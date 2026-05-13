/**
 * Per-account ownership guard tests
 *
 * Tests that:
 *   - POST /agent-templates creates template with ownerAccountId = getEffectiveOwnerId(res)
 *   - PATCH /agent-templates/:id returns 403 if not owner AND not API key listener
 *   - DELETE /agent-templates/:id returns 403 if not owner AND not API key listener
 *   - POST /agent-templates/:id/publish returns 403 if not owner AND not API key listener
 *   - API key listeners can patch/delete/publish any template
 *   - POST /agent-templates/generate creates template owned by authenticated account
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
import { __setAgentAssetsApiKeyOverrideForTests } from "@/middleware/agentAuth";
import { ADMIN_ACCOUNT_ID } from "@/utils/constants";
import { createJwtToken } from "@/utils/jwt";
import { prisma } from "@/utils/prisma";
import { buildAgentTemplatesApp } from "./agent-templates.cross.helpers";

// ---------------------------------------------------------------------------
// Test account IDs
// ---------------------------------------------------------------------------

/** User A — the admin account (already exists in DB) */
const USER_A_ID = ADMIN_ACCOUNT_ID;

/** User B — a different SIWE-authenticated account */
const USER_B_ID = "11111111-2222-4333-4444-555555666667";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const validAgentAssetsApiKey =
  "test-agent-assets-api-key-that-is-at-least-32-characters";

const jwtHeadersFor = async (args: { accountId: string }) => ({
  "Content-Type": "application/json",
  "X-Convos-AuthToken": await createJwtToken({
    deviceId: "test-device-auth-ownership",
    accountId: args.accountId,
  }),
});

const agentKeyHeaders = () => ({
  "Content-Type": "application/json",
  "X-Agent-API-Key": validAgentAssetsApiKey,
});

let server: Server;
const baseURL = "http://localhost:4087";

const app = buildAgentTemplatesApp();

// ---------------------------------------------------------------------------
// DB setup / cleanup
// ---------------------------------------------------------------------------

const cleanupTestRows = async () => {
  await prisma.agentTemplate.deleteMany({
    where: {
      OR: [
        { slug: { startsWith: "own-test-" } },
        { agentName: { startsWith: "Own Test" } },
      ],
    },
  });
};

const ensureUserBAccount = async () => {
  const existing = await prisma.account.findUnique({
    where: { id: USER_B_ID },
  });
  if (!existing) {
    await prisma.account.create({
      data: { id: USER_B_ID },
    });
  }
};

const deleteAccounts = async () => {
  // Only delete accounts we created (not the admin account)
  try {
    await prisma.account.delete({ where: { id: USER_B_ID } });
  } catch {
    // Account may not exist or have related records
  }
};

// ---------------------------------------------------------------------------
// Test suites
// ---------------------------------------------------------------------------

describe("Per-account ownership guards", () => {
  beforeAll(async () => {
    __setAgentAssetsApiKeyOverrideForTests(validAgentAssetsApiKey);
    await ensureUserBAccount();
    await new Promise<void>((resolve) => {
      server = app.listen(4087, () => {
        resolve();
      });
    });
  });

  afterAll(async () => {
    __setAgentAssetsApiKeyOverrideForTests(undefined);
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
    await cleanupTestRows();
    await deleteAccounts();
  });

  beforeEach(async () => {
    __setAgentAssetsApiKeyOverrideForTests(validAgentAssetsApiKey);
    await cleanupTestRows();
  });

  // POST creates template with ownerAccountId from res.locals.accountId
  test("POST creates template with ownerAccountId from authenticated user (JWT)", async () => {
    const response = await fetch(`${baseURL}/api/v2/agent-templates`, {
      method: "POST",
      headers: await jwtHeadersFor({ accountId: USER_A_ID }),
      body: JSON.stringify({
        agentName: "Own Test User A Template",
        prompt: "You are a test",
        slug: "own-test-user-a-template",
      }),
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.ownerAccountId).toBe(USER_A_ID);

    const row = await prisma.agentTemplate.findUniqueOrThrow({
      where: { id: body.id as string },
    });
    expect(row.ownerAccountId).toBe(USER_A_ID);
  });

  test("POST creates template with User B's accountId when User B is authenticated", async () => {
    const response = await fetch(`${baseURL}/api/v2/agent-templates`, {
      method: "POST",
      headers: await jwtHeadersFor({ accountId: USER_B_ID }),
      body: JSON.stringify({
        agentName: "Own Test User B Template",
        prompt: "You are user B's test",
        slug: "own-test-user-b-template",
      }),
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.ownerAccountId).toBe(USER_B_ID);

    const row = await prisma.agentTemplate.findUniqueOrThrow({
      where: { id: body.id as string },
    });
    expect(row.ownerAccountId).toBe(USER_B_ID);
  });

  test("POST creates template with ADMIN_ACCOUNT_ID when API key auth is used", async () => {
    const response = await fetch(`${baseURL}/api/v2/agent-templates`, {
      method: "POST",
      headers: agentKeyHeaders(),
      body: JSON.stringify({
        agentName: "Own Test API Key Template",
        prompt: "You are an API key template",
        slug: "own-test-api-key-template",
      }),
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.ownerAccountId).toBe(ADMIN_ACCOUNT_ID);
  });

  // PATCH returns 403 if not owner AND not API key listener
  test("PATCH returns 403 if caller is not the owner and not an API key listener", async () => {
    // User A creates a template
    const createResponse = await fetch(`${baseURL}/api/v2/agent-templates`, {
      method: "POST",
      headers: await jwtHeadersFor({ accountId: USER_A_ID }),
      body: JSON.stringify({
        agentName: "Own Test Patch Template",
        prompt: "You are a test",
        slug: "own-test-patch-template",
      }),
    });
    const createBody = (await createResponse.json()) as Record<string, unknown>;
    const templateId = createBody.id as string;

    // User B tries to patch it
    const patchResponse = await fetch(
      `${baseURL}/api/v2/agent-templates/${templateId}`,
      {
        method: "PATCH",
        headers: await jwtHeadersFor({ accountId: USER_B_ID }),
        body: JSON.stringify({ agentName: "Patched by User B" }),
      },
    );

    expect(patchResponse.status).toBe(403);
    const patchBody = (await patchResponse.json()) as { error: string };
    expect(patchBody.error).toMatch(/not authorized|forbidden|owner/i);
  });

  // DELETE returns 403 if not owner AND not API key listener
  test("DELETE returns 403 if caller is not the owner and not an API key listener", async () => {
    // User A creates a template
    const createResponse = await fetch(`${baseURL}/api/v2/agent-templates`, {
      method: "POST",
      headers: await jwtHeadersFor({ accountId: USER_A_ID }),
      body: JSON.stringify({
        agentName: "Own Test Delete Template",
        prompt: "You are a test",
        slug: "own-test-delete-template",
      }),
    });
    const createBody = (await createResponse.json()) as Record<string, unknown>;
    const templateId = createBody.id as string;

    // User B tries to delete it
    const deleteResponse = await fetch(
      `${baseURL}/api/v2/agent-templates/${templateId}`,
      {
        method: "DELETE",
        headers: await jwtHeadersFor({ accountId: USER_B_ID }),
      },
    );

    expect(deleteResponse.status).toBe(403);
    const deleteBody = (await deleteResponse.json()) as { error: string };
    expect(deleteBody.error).toMatch(/not authorized|forbidden|owner/i);
  });

  // POST publish returns 403 if not owner AND not API key listener
  test("POST publish returns 403 if caller is not the owner and not an API key listener", async () => {
    // User A creates a draft template
    const createResponse = await fetch(`${baseURL}/api/v2/agent-templates`, {
      method: "POST",
      headers: await jwtHeadersFor({ accountId: USER_A_ID }),
      body: JSON.stringify({
        agentName: "Own Test Publish Template",
        prompt: "You are a test",
        slug: "own-test-publish-template",
      }),
    });
    const createBody = (await createResponse.json()) as Record<string, unknown>;
    const templateId = createBody.id as string;

    // User B tries to publish it
    const publishResponse = await fetch(
      `${baseURL}/api/v2/agent-templates/${templateId}/publish`,
      {
        method: "POST",
        headers: await jwtHeadersFor({ accountId: USER_B_ID }),
      },
    );

    expect(publishResponse.status).toBe(403);
    const publishBody = (await publishResponse.json()) as { error: string };
    expect(publishBody.error).toMatch(/not authorized|forbidden|owner/i);
  });

  // API key listeners can patch/delete/publish any template
  test("API key listener can PATCH any template regardless of ownership", async () => {
    // User A creates a template (owned by User A)
    const createResponse = await fetch(`${baseURL}/api/v2/agent-templates`, {
      method: "POST",
      headers: await jwtHeadersFor({ accountId: USER_A_ID }),
      body: JSON.stringify({
        agentName: "Own Test API Patch",
        prompt: "You are a test",
        slug: "own-test-api-patch",
      }),
    });
    const createBody = (await createResponse.json()) as Record<string, unknown>;
    const templateId = createBody.id as string;

    // API key listener patches it
    const patchResponse = await fetch(
      `${baseURL}/api/v2/agent-templates/${templateId}`,
      {
        method: "PATCH",
        headers: agentKeyHeaders(),
        body: JSON.stringify({ agentName: "Patched by API Key" }),
      },
    );

    expect(patchResponse.status).toBe(200);
    const patchBody = (await patchResponse.json()) as Record<string, unknown>;
    expect(patchBody.agentName).toBe("Patched by API Key");
  });

  test("API key listener can DELETE any template regardless of ownership", async () => {
    // User A creates a draft template (owned by User A)
    const createResponse = await fetch(`${baseURL}/api/v2/agent-templates`, {
      method: "POST",
      headers: await jwtHeadersFor({ accountId: USER_A_ID }),
      body: JSON.stringify({
        agentName: "Own Test API Delete",
        prompt: "You are a test",
        slug: "own-test-api-delete",
      }),
    });
    const createBody = (await createResponse.json()) as Record<string, unknown>;
    const templateId = createBody.id as string;

    // API key listener deletes it
    const deleteResponse = await fetch(
      `${baseURL}/api/v2/agent-templates/${templateId}`,
      {
        method: "DELETE",
        headers: agentKeyHeaders(),
      },
    );

    expect(deleteResponse.status).toBe(200);
  });

  test("API key listener can PUBLISH any template regardless of ownership", async () => {
    // User A creates a draft template (owned by User A)
    const createResponse = await fetch(`${baseURL}/api/v2/agent-templates`, {
      method: "POST",
      headers: await jwtHeadersFor({ accountId: USER_A_ID }),
      body: JSON.stringify({
        agentName: "Own Test API Publish",
        prompt: "You are a test",
        slug: "own-test-api-publish",
      }),
    });
    const createBody = (await createResponse.json()) as Record<string, unknown>;
    const templateId = createBody.id as string;

    // API key listener publishes it
    const publishResponse = await fetch(
      `${baseURL}/api/v2/agent-templates/${templateId}/publish`,
      {
        method: "POST",
        headers: agentKeyHeaders(),
      },
    );

    expect(publishResponse.status).toBe(200);
    const publishBody = (await publishResponse.json()) as Record<
      string,
      unknown
    >;
    expect(publishBody.status).toBe("published");
  });

  // Owner can mutate their own templates
  test("Owner can PATCH their own template", async () => {
    // User A creates a template
    const createResponse = await fetch(`${baseURL}/api/v2/agent-templates`, {
      method: "POST",
      headers: await jwtHeadersFor({ accountId: USER_A_ID }),
      body: JSON.stringify({
        agentName: "Own Test Owner Patch",
        prompt: "You are a test",
        slug: "own-test-owner-patch",
      }),
    });
    const createBody = (await createResponse.json()) as Record<string, unknown>;
    const templateId = createBody.id as string;

    // User A patches their own template
    const patchResponse = await fetch(
      `${baseURL}/api/v2/agent-templates/${templateId}`,
      {
        method: "PATCH",
        headers: await jwtHeadersFor({ accountId: USER_A_ID }),
        body: JSON.stringify({ agentName: "Patched by Owner" }),
      },
    );

    expect(patchResponse.status).toBe(200);
  });

  test("Owner can DELETE their own template", async () => {
    // User A creates a template
    const createResponse = await fetch(`${baseURL}/api/v2/agent-templates`, {
      method: "POST",
      headers: await jwtHeadersFor({ accountId: USER_A_ID }),
      body: JSON.stringify({
        agentName: "Own Test Owner Delete",
        prompt: "You are a test",
        slug: "own-test-owner-delete",
      }),
    });
    const createBody = (await createResponse.json()) as Record<string, unknown>;
    const templateId = createBody.id as string;

    // User A deletes their own template
    const deleteResponse = await fetch(
      `${baseURL}/api/v2/agent-templates/${templateId}`,
      {
        method: "DELETE",
        headers: await jwtHeadersFor({ accountId: USER_A_ID }),
      },
    );

    expect(deleteResponse.status).toBe(200);
  });

  test("Owner can PUBLISH their own template", async () => {
    // User A creates a draft template
    const createResponse = await fetch(`${baseURL}/api/v2/agent-templates`, {
      method: "POST",
      headers: await jwtHeadersFor({ accountId: USER_A_ID }),
      body: JSON.stringify({
        agentName: "Own Test Owner Publish",
        prompt: "You are a test",
        slug: "own-test-owner-publish",
      }),
    });
    const createBody = (await createResponse.json()) as Record<string, unknown>;
    const templateId = createBody.id as string;

    // User A publishes their own template
    const publishResponse = await fetch(
      `${baseURL}/api/v2/agent-templates/${templateId}/publish`,
      {
        method: "POST",
        headers: await jwtHeadersFor({ accountId: USER_A_ID }),
      },
    );

    expect(publishResponse.status).toBe(200);
  });

  // POST /generate creates template owned by authenticated account
  // NOTE: The generate-template handler doesn't exist on this branch
  // (it's on feat/agent-templates-create-job). This assertion will be
  // covered there when that branch incorporates these ownership changes.
  // The key point is that create.ts now uses getEffectiveOwnerId(res)
  // which applies uniformly to all handlers that persist templates.
});
