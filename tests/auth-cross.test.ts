/**
 * Cross-area auth flow tests
 *
 * Tests that:
 *   - User A creates draft → User B cannot see/mutate; User A and API key listener can
 *   - User A publishes → User B can see but cannot mutate
 *   - Unauthenticated callers cannot list or detail any template
 *   - JWT-only user (no accountId) is rejected from write routes with 403
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

const USER_A_ID = ADMIN_ACCOUNT_ID;
const USER_B_ID = "11111111-2222-4333-4444-555555666667";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const validAgentAssetsApiKey =
  "test-agent-assets-api-key-that-is-at-least-32-characters";

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
const baseURL = "http://localhost:4089";

const app = buildAgentTemplatesApp();

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
    __setAgentAssetsApiKeyOverrideForTests(validAgentAssetsApiKey);
    await ensureUserBAccount();
    await new Promise<void>((resolve) => {
      server = app.listen(4089, () => {
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

  // User A creates draft → User B cannot see/mutate; User A and API key listener can
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

  // User A publishes → User B can see but cannot mutate
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

  // Anonymous callers can hit GET list/detail but only see published rows;
  // draft templates 404 and `?status=draft` returns an empty envelope.
  test("Anonymous callers see published-only and cannot reach drafts", async () => {
    // Seed a draft template so we have a concrete URL to attempt.
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

    // (1) Anonymous GET list — 200, draft is invisible (published-only view)
    const listResponse = await fetch(
      `${baseURL}/api/v2/agent-templates?limit=100`,
    );
    expect(listResponse.status).toBe(200);
    const listBody = (await listResponse.json()) as {
      data: Array<{ id: string; status: string }>;
    };
    expect(listBody.data.some((row) => row.id === draftId)).toBe(false);
    for (const row of listBody.data) {
      expect(row.status).toBe("published");
    }

    // (2) Anonymous GET ?status=draft — 200 with an empty envelope
    //     (no enumeration of non-public rows)
    const statusFilterResponse = await fetch(
      `${baseURL}/api/v2/agent-templates?status=draft`,
    );
    expect(statusFilterResponse.status).toBe(200);
    const statusFilterBody = (await statusFilterResponse.json()) as {
      data: unknown[];
      hasMore: boolean;
      nextCursor: string | null;
    };
    expect(statusFilterBody.data).toEqual([]);
    expect(statusFilterBody.hasMore).toBe(false);
    expect(statusFilterBody.nextCursor).toBeNull();

    // (3) Anonymous GET detail on the draft — 404 (drafts are not visible)
    const draftDetailResponse = await fetch(
      `${baseURL}/api/v2/agent-templates/${draftId}`,
    );
    expect(draftDetailResponse.status).toBe(404);
  });

  // JWT-only user (no accountId) is rejected from write routes with 403
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
      `${baseURL}/api/v2/agent-templates/00000000-0000-4000-8000-000000000000`,
      {
        method: "PATCH",
        headers: await jwtOnlyHeaders(),
        body: JSON.stringify({ agentName: "Hacked" }),
      },
    );
    expect(patchResponse.status).toBe(403);

    // DELETE /agent-templates/:id
    const deleteResponse = await fetch(
      `${baseURL}/api/v2/agent-templates/00000000-0000-4000-8000-000000000000`,
      {
        method: "DELETE",
        headers: await jwtOnlyHeaders(),
      },
    );
    expect(deleteResponse.status).toBe(403);

    // POST /agent-templates/:id/publish
    const publishResponse = await fetch(
      `${baseURL}/api/v2/agent-templates/00000000-0000-4000-8000-000000000000/publish`,
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
