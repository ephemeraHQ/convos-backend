import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";
import { __setAgentAssetsApiKeyOverrideForTests } from "@/middleware/agentAuth";
import { ADMIN_ACCOUNT_ID } from "@/utils/constants";
import { prisma } from "@/utils/prisma";
import {
  agentKeyHeaders,
  createTemplate,
  listTemplates,
  startAgentTemplatesServer,
  validAgentAssetsApiKey,
} from "./agent-templates.cross.helpers";

// Covers the list-API additions: free-text `q`, `sort`/`order` (incl. keyset
// cursor under a non-default sort), and the `/counts` aggregate endpoint.
// Tokens are globally unique so search/sort assertions are unaffected by any
// other rows in the test DB; counts assertions are delta-based for the same
// reason.

let baseURL: string;
let closeServer: () => Promise<void>;

const cleanup = () =>
  prisma.agentTemplate.deleteMany({
    where: {
      ownerAccountId: ADMIN_ACCOUNT_ID,
      OR: [
        { slug: { startsWith: "lss-" } },
        { agentName: { startsWith: "Zxq" } },
        { agentName: { startsWith: "Zsort" } },
        { agentName: { startsWith: "Zcount" } },
      ],
    },
  });

const fetchCounts = async (headers: Record<string, string>) => {
  const response = await fetch(`${baseURL}/api/v2/agent-templates/counts`, {
    headers,
  });
  const body = (await response.json()) as {
    total: number;
    byStatus: Record<string, number>;
    byCategory: Record<string, number>;
    featured: number;
  };
  return { response, body };
};

describe("Agent templates list — search / sort / counts", () => {
  beforeAll(async () => {
    __setAgentAssetsApiKeyOverrideForTests(validAgentAssetsApiKey);
    const server = await startAgentTemplatesServer(4093);
    baseURL = server.baseURL;
    closeServer = server.close;
  });

  afterAll(async () => {
    await cleanup();
    await closeServer();
    __setAgentAssetsApiKeyOverrideForTests(undefined);
  });

  beforeEach(async () => {
    await cleanup();
  });

  // ── Free-text search ──
  test("?q= matches agentName OR description, case-insensitively", async () => {
    await createTemplate({
      baseURL,
      headers: agentKeyHeaders(),
      body: {
        agentName: "Zxq One",
        prompt: "p",
        slug: "lss-q-1",
        description: "a trip about zxqhikingtoken stuff",
      },
    });
    await createTemplate({
      baseURL,
      headers: agentKeyHeaders(),
      body: {
        agentName: "Zxq Two",
        prompt: "p",
        slug: "lss-q-2",
        description: "about zxqcookingtoken",
      },
    });
    await createTemplate({
      baseURL,
      headers: agentKeyHeaders(),
      body: {
        agentName: "Zxq Three zxqhikingtoken",
        prompt: "p",
        slug: "lss-q-3",
        description: "plain",
      },
    });

    // description match (One) + agentName match (Three), not Two.
    const hit = await listTemplates({
      baseURL,
      query: "?q=zxqhikingtoken&limit=100",
      headers: agentKeyHeaders(),
    });
    expect(hit.response.status).toBe(200);
    expect(hit.body.data.map((t) => t.agentName as string).sort()).toEqual([
      "Zxq One",
      "Zxq Three zxqhikingtoken",
    ]);

    // case-insensitive
    const upper = await listTemplates({
      baseURL,
      query: "?q=ZXQHIKINGTOKEN&limit=100",
      headers: agentKeyHeaders(),
    });
    expect(upper.body.data.length).toBe(2);

    // distinct token isolates the other row
    const cooking = await listTemplates({
      baseURL,
      query: "?q=zxqcookingtoken&limit=100",
      headers: agentKeyHeaders(),
    });
    expect(cooking.body.data.map((t) => t.agentName as string)).toEqual([
      "Zxq Two",
    ]);
  });

  // ── Sort + keyset cursor under a non-default sort ──
  test("?sort=agentName&order=asc orders results and paginates by cursor", async () => {
    for (const name of ["Zsort Charlie", "Zsort Alpha", "Zsort Bravo"]) {
      await createTemplate({
        baseURL,
        headers: agentKeyHeaders(),
        body: {
          agentName: name,
          prompt: "p",
          slug: `lss-${name.toLowerCase().replace(/\s+/g, "-")}`,
          description: "zsortmarker",
        },
      });
    }

    const sorted = await listTemplates({
      baseURL,
      query: "?q=zsortmarker&sort=agentName&order=asc&limit=100",
      headers: agentKeyHeaders(),
    });
    expect(sorted.body.data.map((t) => t.agentName as string)).toEqual([
      "Zsort Alpha",
      "Zsort Bravo",
      "Zsort Charlie",
    ]);

    // keyset cursor walks the same order one page at a time
    const page1 = await listTemplates({
      baseURL,
      query: "?q=zsortmarker&sort=agentName&order=asc&limit=1",
      headers: agentKeyHeaders(),
    });
    expect(page1.body.data.map((t) => t.agentName as string)).toEqual([
      "Zsort Alpha",
    ]);
    expect(page1.body.hasMore).toBe(true);
    expect(page1.body.nextCursor).toEqual(expect.any(String));

    const page2 = await listTemplates({
      baseURL,
      query: `?q=zsortmarker&sort=agentName&order=asc&limit=1&cursor=${encodeURIComponent(
        page1.body.nextCursor as string,
      )}`,
      headers: agentKeyHeaders(),
    });
    expect(page2.body.data.map((t) => t.agentName as string)).toEqual([
      "Zsort Bravo",
    ]);
  });

  test("a cursor built for a different sort is rejected with 400", async () => {
    const res = await fetch(
      // a createdAt cursor shape used with sort=agentName → malformed
      `${baseURL}/api/v2/agent-templates?sort=agentName&cursor=${Buffer.from(
        JSON.stringify({
          id: "x",
          s: "createdAt",
          v: new Date().toISOString(),
        }),
      ).toString("base64url")}`,
      { headers: agentKeyHeaders() },
    );
    expect(res.status).toBe(400);
  });

  // ── Counts ──
  test("/counts returns visibility-scoped aggregates (delta-checked)", async () => {
    const before = await fetchCounts(agentKeyHeaders());
    expect(before.response.status).toBe(200);
    for (const s of ["published", "draft", "unlisted", "archived"]) {
      expect(typeof before.body.byStatus[s]).toBe("number");
    }
    expect(typeof before.body.total).toBe("number");
    expect(typeof before.body.featured).toBe("number");
    expect(typeof before.body.byCategory).toBe("object");

    // New template is a featured draft → total +1, draft +1, featured +1.
    await createTemplate({
      baseURL,
      headers: agentKeyHeaders(),
      body: {
        agentName: "Zcount Featured",
        prompt: "p",
        slug: "lss-count-1",
        featured: true,
      },
    });

    const after = await fetchCounts(agentKeyHeaders());
    expect(after.body.total).toBe(before.body.total + 1);
    expect(after.body.byStatus.draft).toBe(before.body.byStatus.draft + 1);
    expect(after.body.featured).toBe(before.body.featured + 1);
  });
});
