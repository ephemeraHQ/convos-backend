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
  getTemplate,
  jwtHeaders,
  listTemplates,
  patchTemplate,
  publishTemplate,
  startAgentTemplatesServer,
  validAgentAssetsApiKey,
} from "./agent-templates.cross.helpers";

// Covers the list-API additions: free-text `q`, `sort`/`order` (incl. keyset
// cursor under a non-default sort), the `featuredRank` gallery ordering, and
// the `/counts` aggregate endpoint.
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
        { agentName: { startsWith: "Zrank" } },
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

  // ── Featured gallery curation ──
  test("?sort=featuredRank&order=desc leads with the heaviest row and sinks unranked ones", async () => {
    // Only a published template can hold a gallery position, so each row goes
    // public before it's weighted.
    const seed = async (name: string, rank: number | undefined) => {
      const created = await createTemplate({
        baseURL,
        headers: agentKeyHeaders(),
        body: {
          agentName: name,
          prompt: "p",
          slug: `lss-${name.toLowerCase().replace(/\s+/g, "-")}`,
          description: "zrankmarker",
        },
      });
      const id = created.body.id as string;
      await publishTemplate({ baseURL, headers: agentKeyHeaders(), id });
      await patchTemplate({
        baseURL,
        headers: agentKeyHeaders(),
        id,
        body:
          rank === undefined
            ? { featured: true }
            : { featured: true, featuredRank: rank },
      });
      return id;
    };

    await seed("Zrank Light", 10);
    await seed("Zrank Heavy", 30);
    await seed("Zrank Middle", 20);
    // Featured with no explicit weight — the default 0 must not seize the lead.
    await seed("Zrank Unranked", undefined);

    const gallery = await listTemplates({
      baseURL,
      query:
        "?q=zrankmarker&featured=true&sort=featuredRank&order=desc&limit=100",
      headers: agentKeyHeaders(),
    });
    expect(gallery.response.status).toBe(200);
    expect(gallery.body.data.map((t) => t.agentName as string)).toEqual([
      "Zrank Heavy",
      "Zrank Middle",
      "Zrank Light",
      "Zrank Unranked",
    ]);
    // The weight is serialized, so the dashboard can compute the next move.
    expect(gallery.body.data.map((t) => t.featuredRank as number)).toEqual([
      30, 20, 10, 0,
    ]);

    // keyset cursor walks the same order one page at a time
    const page1 = await listTemplates({
      baseURL,
      query:
        "?q=zrankmarker&featured=true&sort=featuredRank&order=desc&limit=1",
      headers: agentKeyHeaders(),
    });
    expect(page1.body.data.map((t) => t.agentName as string)).toEqual([
      "Zrank Heavy",
    ]);
    expect(page1.body.hasMore).toBe(true);

    const page2 = await listTemplates({
      baseURL,
      query: `?q=zrankmarker&featured=true&sort=featuredRank&order=desc&limit=1&cursor=${encodeURIComponent(
        page1.body.nextCursor as string,
      )}`,
      headers: agentKeyHeaders(),
    });
    expect(page2.body.data.map((t) => t.agentName as string)).toEqual([
      "Zrank Middle",
    ]);
  });

  test("a featuredRank outside the column's Int range is rejected", async () => {
    const created = await createTemplate({
      baseURL,
      headers: agentKeyHeaders(),
      body: {
        agentName: "Zrank Bounds",
        prompt: "p",
        slug: "lss-rank-bounds",
        description: "zrankmarker",
      },
    });
    const id = created.body.id as string;

    const negative = await patchTemplate({
      baseURL,
      headers: agentKeyHeaders(),
      id,
      body: { featuredRank: -1 },
    });
    expect(negative.response.status).toBe(400);

    // Above Postgres' Int ceiling. Without the cap this clears Zod and dies at
    // persistence, surfacing as a 500 rather than a validation error.
    const tooLarge = await patchTemplate({
      baseURL,
      headers: agentKeyHeaders(),
      id,
      body: { featuredRank: 2_147_483_648 },
    });
    expect(tooLarge.response.status).toBe(400);
  });

  // Curation is not an ownership right: the PATCH guard admits the template's
  // owner, so without a separate gate an owner could weight their own template
  // to the top of the convos.org homepage, above the whole curated gallery.
  test("only the dashboard's API key may write featuredRank", async () => {
    const created = await createTemplate({
      baseURL,
      headers: agentKeyHeaders(),
      body: {
        agentName: "Zrank Owner",
        prompt: "p",
        slug: "lss-rank-owner",
        description: "zrankmarker",
      },
    });
    const id = created.body.id as string;
    await publishTemplate({ baseURL, headers: agentKeyHeaders(), id });

    // The owner, authenticated as a user rather than as the dashboard.
    const selfPromote = await patchTemplate({
      baseURL,
      headers: await jwtHeaders(),
      id,
      body: { featuredRank: 2_000_000_000 },
    });
    expect(selfPromote.response.status).toBe(403);

    // …and the weight did not move.
    const after = await getTemplate({
      baseURL,
      path: id,
      headers: agentKeyHeaders(),
    });
    expect(after.body.featuredRank).toBe(0);

    // The same owner still edits their own content — only curation is gated.
    const contentEdit = await patchTemplate({
      baseURL,
      headers: await jwtHeaders(),
      id,
      body: { emoji: "🛶" },
    });
    expect(contentEdit.response.status).toBe(200);

    // The dashboard writes the weight.
    const curated = await patchTemplate({
      baseURL,
      headers: agentKeyHeaders(),
      id,
      body: { featuredRank: 42 },
    });
    expect(curated.response.status).toBe(200);
    expect(curated.body.featuredRank).toBe(42);
  });

  // A weight is a homepage slot, and the gallery only renders published rows —
  // so a template that isn't public holds no position in the order.
  test("only a published template can hold a gallery position", async () => {
    const created = await createTemplate({
      baseURL,
      headers: agentKeyHeaders(),
      body: {
        agentName: "Zrank Unpublished",
        prompt: "p",
        slug: "lss-rank-unpublished",
        description: "zrankmarker",
      },
    });
    const id = created.body.id as string;

    // A draft can't be weighted at all.
    const onDraft = await patchTemplate({
      baseURL,
      headers: agentKeyHeaders(),
      id,
      body: { featured: true, featuredRank: 9 },
    });
    expect(onDraft.response.status).toBe(400);

    // Published, it can.
    await publishTemplate({ baseURL, headers: agentKeyHeaders(), id });
    const curated = await patchTemplate({
      baseURL,
      headers: agentKeyHeaders(),
      id,
      body: { featuredRank: 9 },
    });
    expect(curated.response.status).toBe(200);
    expect(curated.body.featuredRank).toBe(9);

    // Taken back out of public view, it gives the slot up rather than holding
    // it — so re-publishing enters it at the end instead of silently reclaiming
    // the position it used to occupy.
    const unpublished = await patchTemplate({
      baseURL,
      headers: agentKeyHeaders(),
      id,
      body: { status: "draft" },
    });
    expect(unpublished.response.status).toBe(200);
    expect(unpublished.body.featuredRank).toBe(0);

    const republished = await publishTemplate({
      baseURL,
      headers: agentKeyHeaders(),
      id,
    });
    expect(republished.body.featuredRank).toBe(0);
  });

  test("a template made public in the same PATCH may be weighted by it", async () => {
    const created = await createTemplate({
      baseURL,
      headers: agentKeyHeaders(),
      body: {
        agentName: "Zrank Atomic",
        prompt: "p",
        slug: "lss-rank-atomic",
        description: "zrankmarker",
      },
    });
    const id = created.body.id as string;
    // A draft's first publish must go through /publish, so get it public first,
    // then flip unlisted → published and weight it in one call.
    await publishTemplate({ baseURL, headers: agentKeyHeaders(), id });
    await patchTemplate({
      baseURL,
      headers: agentKeyHeaders(),
      id,
      body: { status: "unlisted" },
    });

    const atomic = await patchTemplate({
      baseURL,
      headers: agentKeyHeaders(),
      id,
      body: { status: "published", featured: true, featuredRank: 4 },
    });
    expect(atomic.response.status).toBe(200);
    expect(atomic.body.featuredRank).toBe(4);
  });

  test("a cursor built for a different sort is rejected with 400", async () => {
    const res = await fetch(
      // a well-formed createdAt cursor (order matches the default desc) used
      // with sort=agentName → sort mismatch → rejected.
      `${baseURL}/api/v2/agent-templates?sort=agentName&cursor=${Buffer.from(
        JSON.stringify({
          id: "x",
          o: "desc",
          s: "createdAt",
          v: new Date().toISOString(),
        }),
      ).toString("base64url")}`,
      { headers: agentKeyHeaders() },
    );
    expect(res.status).toBe(400);
  });

  test("a cursor built for a different order is rejected with 400", async () => {
    for (const name of ["Zsort Order A", "Zsort Order B"]) {
      await createTemplate({
        baseURL,
        headers: agentKeyHeaders(),
        body: {
          agentName: name,
          prompt: "p",
          slug: `lss-${name.toLowerCase().replace(/\s+/g, "-")}`,
          description: "zsortordermarker",
        },
      });
    }

    // A real cursor minted under order=desc...
    const desc = await listTemplates({
      baseURL,
      query: "?q=zsortordermarker&sort=agentName&order=desc&limit=1",
      headers: agentKeyHeaders(),
    });
    expect(desc.body.nextCursor).toEqual(expect.any(String));
    const cursor = encodeURIComponent(desc.body.nextCursor as string);

    // ...reused under order=asc would flip the keyset comparator (lt↔gt) and
    // traverse from the opposite end → rejected.
    const flipped = await fetch(
      `${baseURL}/api/v2/agent-templates?q=zsortordermarker&sort=agentName&order=asc&limit=1&cursor=${cursor}`,
      { headers: agentKeyHeaders() },
    );
    expect(flipped.status).toBe(400);

    // ...but reused under the same order=desc still paginates fine.
    const same = await listTemplates({
      baseURL,
      query: `?q=zsortordermarker&sort=agentName&order=desc&limit=1&cursor=${cursor}`,
      headers: agentKeyHeaders(),
    });
    expect(same.response.status).toBe(200);
  });

  test("?q= and ?featured=true compose (AND of search OR-clause + featured)", async () => {
    await createTemplate({
      baseURL,
      headers: agentKeyHeaders(),
      body: {
        agentName: "Zxq Combined Featured",
        prompt: "p",
        slug: "lss-combo-1",
        description: "zxqcombomarker",
        featured: true,
      },
    });
    await createTemplate({
      baseURL,
      headers: agentKeyHeaders(),
      body: {
        agentName: "Zxq Combined Plain",
        prompt: "p",
        slug: "lss-combo-2",
        description: "zxqcombomarker",
        featured: false,
      },
    });

    // q matches both rows...
    const both = await listTemplates({
      baseURL,
      query: "?q=zxqcombomarker&limit=100",
      headers: agentKeyHeaders(),
    });
    expect(both.body.data.length).toBe(2);

    // ...featured=true narrows to the one featured match.
    const featuredOnly = await listTemplates({
      baseURL,
      query: "?q=zxqcombomarker&featured=true&limit=100",
      headers: agentKeyHeaders(),
    });
    expect(featuredOnly.body.data.map((t) => t.agentName as string)).toEqual([
      "Zxq Combined Featured",
    ]);
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
