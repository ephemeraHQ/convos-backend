/**
 * List/detail visibility rule tests
 *
 * The list and detail endpoints are public. Anonymous callers see only
 * published templates; authenticated callers additionally see their own
 * drafts/unlisted/archived rows.
 *
 * Tests that:
 *   - Unauthenticated GET /agent-templates returns published-only
 *   - Authenticated GET /agent-templates returns published + own drafts/unlisted/archived
 *   - GET /agent-templates?status=draft returns empty result for anonymous callers
 *   - GET /agent-templates?status=draft returns caller's own drafts for authenticated users
 *   - GET /agent-templates/:id returns 404 for draft templates not owned by caller
 *   - GET /agent-templates/:id returns template for drafts owned by caller
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
    deviceId: "test-device-auth-visibility",
    accountId,
  }),
});

const agentKeyHeaders = () => ({
  "Content-Type": "application/json",
  "X-Agent-API-Key": validAgentAssetsApiKey,
});

let server: Server;
const baseURL = "http://localhost:4088";

const app = buildAgentTemplatesApp();

// ---------------------------------------------------------------------------
// DB setup / cleanup
// ---------------------------------------------------------------------------

const cleanupTestRows = async () => {
  await prisma.agentTemplate.deleteMany({
    where: {
      OR: [
        { slug: { startsWith: "vis-test-" } },
        { agentName: { startsWith: "Vis Test" } },
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

describe("List/detail visibility rules", () => {
  beforeAll(async () => {
    __setAgentAssetsApiKeyOverrideForTests(validAgentAssetsApiKey);
    await ensureUserBAccount();
    server = app.listen(4088);
  });

  afterAll(async () => {
    __setAgentAssetsApiKeyOverrideForTests(undefined);
    server.close();
    await cleanupTestRows();
    await deleteAccounts();
  });

  beforeEach(async () => {
    __setAgentAssetsApiKeyOverrideForTests(validAgentAssetsApiKey);
    await cleanupTestRows();
  });

  // Unauthenticated GET returns 200 with the published-only view
  test("Unauthenticated GET /agent-templates returns 200 with published-only view", async () => {
    // Create one published and one draft template — the anonymous lister
    // should see the published row but not the draft.
    const pubResponse = await fetch(`${baseURL}/api/v2/agent-templates`, {
      method: "POST",
      headers: await jwtHeadersFor(USER_A_ID),
      body: JSON.stringify({
        agentName: "Vis Test Anon Pub",
        prompt: "Published",
        slug: "vis-test-anon-pub",
      }),
    });
    expect(pubResponse.status).toBe(201);
    const pubBody = (await pubResponse.json()) as Record<string, unknown>;
    const pubId = pubBody.id as string;
    expect(pubId).toBeDefined();
    const publishResponse = await fetch(
      `${baseURL}/api/v2/agent-templates/${pubId}/publish`,
      {
        method: "POST",
        headers: await jwtHeadersFor(USER_A_ID),
      },
    );
    expect(publishResponse.status).toBe(200);

    const draftResponse = await fetch(`${baseURL}/api/v2/agent-templates`, {
      method: "POST",
      headers: await jwtHeadersFor(USER_A_ID),
      body: JSON.stringify({
        agentName: "Vis Test Anon Draft",
        prompt: "Draft",
        slug: "vis-test-anon-draft",
      }),
    });
    expect(draftResponse.status).toBe(201);
    const draftBody = (await draftResponse.json()) as Record<string, unknown>;
    const draftId = draftBody.id as string;
    expect(draftId).toBeDefined();

    const listResponse = await fetch(
      `${baseURL}/api/v2/agent-templates?limit=100`,
    );
    expect(listResponse.status).toBe(200);
    const listBody = (await listResponse.json()) as {
      data: Record<string, unknown>[];
    };

    expect(listBody.data.some((t) => t.id === pubId)).toBe(true);
    expect(listBody.data.some((t) => t.id === draftId)).toBe(false);
    for (const t of listBody.data) {
      expect(t.status).toBe("published");
    }
  });

  // Optional-auth: present-but-invalid credentials must still 401.
  // "No header" → anonymous path; "header with garbage value" → strict
  // auth path → 401. The middleware's contract is "opt-in: if you opt in,
  // they have to be valid", so we verify that for both header shapes.
  test("Invalid credentials on optional-auth routes still return 401", async () => {
    const garbageJwt = await fetch(
      `${baseURL}/api/v2/agent-templates?limit=10`,
      { headers: { "X-Convos-AuthToken": "not-a-real-jwt" } },
    );
    expect(garbageJwt.status).toBe(401);

    const garbageAgentKey = await fetch(
      `${baseURL}/api/v2/agent-templates?limit=10`,
      { headers: { "X-Agent-API-Key": "not-the-real-key-just-a-stub" } },
    );
    expect(garbageAgentKey.status).toBe(401);

    // Whitespace-only token is *present* and therefore opt-in to auth —
    // strict path runs and fails. This is what the trimmed-vs-raw header
    // check in `optionalAuthOrAgentApiKeyAuth` enforces.
    const whitespaceJwt = await fetch(
      `${baseURL}/api/v2/agent-templates?limit=10`,
      { headers: { "X-Convos-AuthToken": "   " } },
    );
    expect(whitespaceJwt.status).toBe(401);
  });

  // Authenticated GET returns published + own drafts/unlisted/archived
  test("Authenticated GET returns published + own drafts/unlisted/archived", async () => {
    // Create a published template (owned by admin)
    const pubResponse = await fetch(`${baseURL}/api/v2/agent-templates`, {
      method: "POST",
      headers: await jwtHeadersFor(USER_A_ID),
      body: JSON.stringify({
        agentName: "Vis Test Pub A",
        prompt: "Published",
        slug: "vis-test-pub-a",
      }),
    });
    expect(pubResponse.status).toBe(201);
    const pubBody = (await pubResponse.json()) as Record<string, unknown>;
    const pubId = pubBody.id as string;
    expect(pubId).toBeDefined();
    const publishResponse = await fetch(
      `${baseURL}/api/v2/agent-templates/${pubId}/publish`,
      {
        method: "POST",
        headers: await jwtHeadersFor(USER_A_ID),
      },
    );
    expect(publishResponse.status).toBe(200);

    // User B creates a draft
    const bDraftResponse = await fetch(`${baseURL}/api/v2/agent-templates`, {
      method: "POST",
      headers: await jwtHeadersFor(USER_B_ID),
      body: JSON.stringify({
        agentName: "Vis Test Draft B",
        prompt: "Draft by B",
        slug: "vis-test-draft-b",
      }),
    });
    expect(bDraftResponse.status).toBe(201);
    const bDraftBody = (await bDraftResponse.json()) as Record<string, unknown>;
    const bDraftId = bDraftBody.id as string;
    expect(bDraftId).toBeDefined();

    // User A creates a draft
    const aDraftResponse = await fetch(`${baseURL}/api/v2/agent-templates`, {
      method: "POST",
      headers: await jwtHeadersFor(USER_A_ID),
      body: JSON.stringify({
        agentName: "Vis Test Draft A",
        prompt: "Draft by A",
        slug: "vis-test-draft-a",
      }),
    });
    expect(aDraftResponse.status).toBe(201);
    const aDraftBody = (await aDraftResponse.json()) as Record<string, unknown>;
    const aDraftId = aDraftBody.id as string;
    expect(aDraftId).toBeDefined();

    // User B lists — should see published + own draft, NOT User A's draft
    const bListResponse = await fetch(
      `${baseURL}/api/v2/agent-templates?limit=100`,
      { headers: await jwtHeadersFor(USER_B_ID) },
    );
    expect(bListResponse.status).toBe(200);
    const bListBody = (await bListResponse.json()) as {
      data: Record<string, unknown>[];
    };

    // User B should see published template
    expect(bListBody.data.some((t) => t.id === pubId)).toBe(true);

    // User B should see their own draft
    expect(bListBody.data.some((t) => t.id === bDraftId)).toBe(true);

    // User B should NOT see User A's draft
    expect(bListBody.data.some((t) => t.id === aDraftId)).toBe(false);
  });

  // GET ?status=draft returns empty result for anonymous callers
  test("GET ?status=draft returns empty result for anonymous callers", async () => {
    // Create a draft so the table is non-empty for this filter; anonymous
    // callers still see nothing.
    await fetch(`${baseURL}/api/v2/agent-templates`, {
      method: "POST",
      headers: await jwtHeadersFor(USER_A_ID),
      body: JSON.stringify({
        agentName: "Vis Test Anon Filter",
        prompt: "Draft",
        slug: "vis-test-anon-filter",
      }),
    });

    const response = await fetch(
      `${baseURL}/api/v2/agent-templates?status=draft`,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: Record<string, unknown>[];
      hasMore: boolean;
      nextCursor: string | null;
    };
    expect(body.data).toEqual([]);
    expect(body.hasMore).toBe(false);
    expect(body.nextCursor).toBeNull();
  });

  // GET ?status=draft returns caller's own drafts for authed users
  test("GET ?status=draft returns caller's own drafts for authenticated users", async () => {
    // User A creates a draft
    const aDraftResponse = await fetch(`${baseURL}/api/v2/agent-templates`, {
      method: "POST",
      headers: await jwtHeadersFor(USER_A_ID),
      body: JSON.stringify({
        agentName: "Vis Test Status Filter A",
        prompt: "Draft by A",
        slug: "vis-test-status-filter-a",
      }),
    });
    const aDraftBody = (await aDraftResponse.json()) as Record<string, unknown>;
    const aDraftId = aDraftBody.id as string;

    // User B creates a draft
    const bDraftResponse = await fetch(`${baseURL}/api/v2/agent-templates`, {
      method: "POST",
      headers: await jwtHeadersFor(USER_B_ID),
      body: JSON.stringify({
        agentName: "Vis Test Status Filter B",
        prompt: "Draft by B",
        slug: "vis-test-status-filter-b",
      }),
    });
    const bDraftBody = (await bDraftResponse.json()) as Record<string, unknown>;
    const bDraftId = bDraftBody.id as string;

    // User A queries ?status=draft
    const aListResponse = await fetch(
      `${baseURL}/api/v2/agent-templates?status=draft`,
      { headers: await jwtHeadersFor(USER_A_ID) },
    );
    expect(aListResponse.status).toBe(200);
    const aListBody = (await aListResponse.json()) as {
      data: Record<string, unknown>[];
    };

    // Should contain User A's draft
    expect(aListBody.data.some((t) => t.id === aDraftId)).toBe(true);

    // Should NOT contain User B's draft
    expect(aListBody.data.some((t) => t.id === bDraftId)).toBe(false);

    // All returned templates should be drafts owned by User A
    for (const t of aListBody.data) {
      expect(t.status).toBe("draft");
      expect(t.ownerAccountId).toBe(USER_A_ID);
    }
  });

  // Detail returns 404 for drafts not owned by caller
  test("GET /:id returns 404 for draft templates not owned by the caller", async () => {
    // User A creates a draft
    const createResponse = await fetch(`${baseURL}/api/v2/agent-templates`, {
      method: "POST",
      headers: await jwtHeadersFor(USER_A_ID),
      body: JSON.stringify({
        agentName: "Vis Test Detail 404",
        prompt: "Draft by A",
        slug: "vis-test-detail-404",
      }),
    });
    const createBody = (await createResponse.json()) as Record<string, unknown>;
    const templateId = createBody.id as string;

    // User B tries to get it — should return 404 (not 403)
    const detailResponse = await fetch(
      `${baseURL}/api/v2/agent-templates/${templateId}`,
      { headers: await jwtHeadersFor(USER_B_ID) },
    );

    expect(detailResponse.status).toBe(404);
  });

  test("GET /:id returns 404 for anonymous callers on a draft template", async () => {
    // User A creates a draft
    const createResponse = await fetch(`${baseURL}/api/v2/agent-templates`, {
      method: "POST",
      headers: await jwtHeadersFor(USER_A_ID),
      body: JSON.stringify({
        agentName: "Vis Test Detail Anon",
        prompt: "Draft by A",
        slug: "vis-test-detail-anon",
      }),
    });
    const createBody = (await createResponse.json()) as Record<string, unknown>;
    const templateId = createBody.id as string;

    // Anonymous caller — drafts are not visible to anonymous callers,
    // so the response is 404 (indistinguishable from a missing row).
    const detailResponse = await fetch(
      `${baseURL}/api/v2/agent-templates/${templateId}`,
    );

    expect(detailResponse.status).toBe(404);
  });

  // Detail returns template for drafts owned by the caller
  test("GET /:id returns template for drafts owned by the caller", async () => {
    // User A creates a draft
    const createResponse = await fetch(`${baseURL}/api/v2/agent-templates`, {
      method: "POST",
      headers: await jwtHeadersFor(USER_A_ID),
      body: JSON.stringify({
        agentName: "Vis Test Detail Own",
        prompt: "Draft by A",
        slug: "vis-test-detail-own",
      }),
    });
    const createBody = (await createResponse.json()) as Record<string, unknown>;
    const templateId = createBody.id as string;

    // User A gets their own draft — should return 200
    const detailResponse = await fetch(
      `${baseURL}/api/v2/agent-templates/${templateId}`,
      { headers: await jwtHeadersFor(USER_A_ID) },
    );

    expect(detailResponse.status).toBe(200);
    const detailBody = (await detailResponse.json()) as Record<string, unknown>;
    expect(detailBody.id).toBe(templateId);
    expect(detailBody.status).toBe("draft");
  });

  // API key listener can see draft templates (admin-like access)
  test("API key listener can GET draft templates regardless of ownership", async () => {
    // User A creates a draft
    const createResponse = await fetch(`${baseURL}/api/v2/agent-templates`, {
      method: "POST",
      headers: await jwtHeadersFor(USER_A_ID),
      body: JSON.stringify({
        agentName: "Vis Test API Key Detail",
        prompt: "Draft by A",
        slug: "vis-test-api-key-detail",
      }),
    });
    const createBody = (await createResponse.json()) as Record<string, unknown>;
    const templateId = createBody.id as string;

    // API key listener gets the draft — should return 200
    const detailResponse = await fetch(
      `${baseURL}/api/v2/agent-templates/${templateId}`,
      { headers: agentKeyHeaders() },
    );

    expect(detailResponse.status).toBe(200);
    const detailBody = (await detailResponse.json()) as Record<string, unknown>;
    expect(detailBody.id).toBe(templateId);
    expect(detailBody.status).toBe("draft");
  });

  // Published templates visible to everyone via detail
  test("Published template is visible to all users via detail", async () => {
    // User A creates and publishes
    const createResponse = await fetch(`${baseURL}/api/v2/agent-templates`, {
      method: "POST",
      headers: await jwtHeadersFor(USER_A_ID),
      body: JSON.stringify({
        agentName: "Vis Test Pub Detail",
        prompt: "Published by A",
        slug: "vis-test-pub-detail",
      }),
    });
    expect(createResponse.status).toBe(201);
    const createBody = (await createResponse.json()) as Record<string, unknown>;
    const templateId = createBody.id as string;
    expect(templateId).toBeDefined();

    const publishResponse = await fetch(
      `${baseURL}/api/v2/agent-templates/${templateId}/publish`,
      {
        method: "POST",
        headers: await jwtHeadersFor(USER_A_ID),
      },
    );
    expect(publishResponse.status).toBe(200);

    // Any authenticated user can see it
    const bDetailResponse = await fetch(
      `${baseURL}/api/v2/agent-templates/${templateId}`,
      { headers: await jwtHeadersFor(USER_B_ID) },
    );
    expect(bDetailResponse.status).toBe(200);

    // Anonymous callers can also see published rows (public discovery).
    const unauthResponse = await fetch(
      `${baseURL}/api/v2/agent-templates/${templateId}`,
    );
    expect(unauthResponse.status).toBe(200);
    const unauthBody = (await unauthResponse.json()) as Record<string, unknown>;
    expect(unauthBody.id).toBe(templateId);
    expect(unauthBody.status).toBe("published");
  });

  // Status filter with unlisted/archived for authenticated users
  test("Authenticated GET ?status=unlisted returns own unlisted templates", async () => {
    // Create and publish, then change to unlisted
    const createResponse = await fetch(`${baseURL}/api/v2/agent-templates`, {
      method: "POST",
      headers: await jwtHeadersFor(USER_A_ID),
      body: JSON.stringify({
        agentName: "Vis Test Unlisted",
        prompt: "Unlisted by A",
        slug: "vis-test-unlisted",
      }),
    });
    const createBody = (await createResponse.json()) as Record<string, unknown>;
    const templateId = createBody.id as string;

    // Publish first (draft → published)
    await fetch(`${baseURL}/api/v2/agent-templates/${templateId}/publish`, {
      method: "POST",
      headers: await jwtHeadersFor(USER_A_ID),
    });

    // Then set to unlisted
    await fetch(`${baseURL}/api/v2/agent-templates/${templateId}`, {
      method: "PATCH",
      headers: await jwtHeadersFor(USER_A_ID),
      body: JSON.stringify({ status: "unlisted" }),
    });

    // User A queries ?status=unlisted
    const listResponse = await fetch(
      `${baseURL}/api/v2/agent-templates?status=unlisted`,
      { headers: await jwtHeadersFor(USER_A_ID) },
    );
    expect(listResponse.status).toBe(200);
    const listBody = (await listResponse.json()) as {
      data: Record<string, unknown>[];
    };

    expect(listBody.data.some((t) => t.id === templateId)).toBe(true);
  });
});
