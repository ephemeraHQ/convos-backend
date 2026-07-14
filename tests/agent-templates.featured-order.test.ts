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
  jwtHeaders,
  listTemplates,
  patchTemplate,
  publishTemplate,
  startAgentTemplatesServer,
  validAgentAssetsApiKey,
} from "./agent-templates.cross.helpers";

// PUT /featured-order writes the gallery's order whole, in one transaction —
// so a reorder is never half-applied on the homepage. The suite leans on that:
// every rejection asserts the stored weights are byte-identical afterwards.

let baseURL: string;
let closeServer: () => Promise<void>;

const cleanup = () =>
  prisma.agentTemplate.deleteMany({
    where: {
      ownerAccountId: ADMIN_ACCOUNT_ID,
      slug: { startsWith: "fo-" },
    },
  });

const setOrder = async (args: {
  templateIds: string[];
  headers?: Record<string, string>;
}) => {
  const response = await fetch(
    `${baseURL}/api/v2/agent-templates/featured-order`,
    {
      method: "PUT",
      headers: args.headers ?? agentKeyHeaders(),
      body: JSON.stringify({ templateIds: args.templateIds }),
    },
  );
  const body = (await response.json()) as Record<string, unknown>;
  return { body, response };
};

// A featured, published template — the only kind that holds a slot.
const seedGalleryTemplate = async (name: string) => {
  const created = await createTemplate({
    baseURL,
    headers: agentKeyHeaders(),
    body: {
      agentName: name,
      prompt: "p",
      slug: `fo-${name.toLowerCase()}`,
      description: "fomarker",
    },
  });
  const id = created.body.id as string;
  await publishTemplate({ baseURL, headers: agentKeyHeaders(), id });
  await patchTemplate({
    baseURL,
    headers: agentKeyHeaders(),
    id,
    body: { featured: true },
  });
  return id;
};

const weights = async () => {
  const rows = await prisma.agentTemplate.findMany({
    where: { slug: { startsWith: "fo-" } },
    select: { agentName: true, featuredRank: true },
    orderBy: { agentName: "asc" },
  });
  return rows.map((r) => `${r.agentName}=${r.featuredRank}`).join(",");
};

describe("Agent templates — featured gallery order", () => {
  beforeAll(async () => {
    __setAgentAssetsApiKeyOverrideForTests(validAgentAssetsApiKey);
    const server = await startAgentTemplatesServer(4097);
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

  test("writes the whole order, heaviest first", async () => {
    const one = await seedGalleryTemplate("Fone");
    const two = await seedGalleryTemplate("Ftwo");
    const three = await seedGalleryTemplate("Fthree");

    const res = await setOrder({ templateIds: [three, one, two] });
    expect(res.response.status).toBe(200);
    expect(res.body.updated).toBe(3);

    const gallery = await listTemplates({
      baseURL,
      query: "?featured=true&sort=featuredRank&order=desc&limit=100",
      headers: agentKeyHeaders(),
    });
    expect(gallery.body.data.map((t) => t.agentName as string)).toEqual([
      "Fthree",
      "Fone",
      "Ftwo",
    ]);
    // Dense, top-down: the lead slot carries the largest weight.
    expect(gallery.body.data.map((t) => t.featuredRank as number)).toEqual([
      3, 2, 1,
    ]);
  });

  test("a partial list is refused — it would collide with the rows it omits", async () => {
    const one = await seedGalleryTemplate("Fone");
    await seedGalleryTemplate("Ftwo");
    const before = await weights();

    const res = await setOrder({ templateIds: [one] });
    expect(res.response.status).toBe(409);
    expect(await weights()).toBe(before);
  });

  test("a gallery that changed underneath is refused, not clobbered", async () => {
    const one = await seedGalleryTemplate("Fone");
    const two = await seedGalleryTemplate("Ftwo");
    await setOrder({ templateIds: [one, two] });

    // Someone else features a third template between the read and the write. It
    // joins at the end (weight 0), and the two that were ordered keep theirs.
    const three = await seedGalleryTemplate("Fthree");
    const before = await weights();

    // The caller still thinks the gallery is two templates.
    const stale = await setOrder({ templateIds: [two, one] });
    expect(stale.response.status).toBe(409);
    expect((stale.body.error as { code: string }).code).toBe("GALLERY_CHANGED");
    expect(await weights()).toBe(before);

    // Re-read and it goes through.
    const fresh = await setOrder({ templateIds: [two, one, three] });
    expect(fresh.response.status).toBe(200);
  });

  test("an id outside the gallery is refused", async () => {
    const inGallery = await seedGalleryTemplate("Fone");
    // Published, but never featured — so it holds no slot.
    const outside = await createTemplate({
      baseURL,
      headers: agentKeyHeaders(),
      body: {
        agentName: "Foutside",
        prompt: "p",
        slug: "fo-outside",
        description: "fomarker",
      },
    });
    const outsideId = outside.body.id as string;
    await publishTemplate({
      baseURL,
      headers: agentKeyHeaders(),
      id: outsideId,
    });
    const before = await weights();

    const res = await setOrder({ templateIds: [outsideId, inGallery] });
    expect(res.response.status).toBe(409);
    expect(await weights()).toBe(before);
  });

  test("the same template twice is refused", async () => {
    const one = await seedGalleryTemplate("Fone");
    await seedGalleryTemplate("Ftwo");
    const before = await weights();

    const res = await setOrder({ templateIds: [one, one] });
    expect(res.response.status).toBe(400);
    expect((res.body.error as { code: string }).code).toBe(
      "DUPLICATE_TEMPLATE",
    );
    expect(await weights()).toBe(before);
  });

  test("only the dashboard's API key may write the order", async () => {
    const one = await seedGalleryTemplate("Fone");
    const two = await seedGalleryTemplate("Ftwo");
    const before = await weights();

    // The templates' own owner, authenticated as a user rather than as the
    // dashboard: curation is not an ownership right.
    const res = await setOrder({
      templateIds: [two, one],
      headers: await jwtHeaders(),
    });
    expect(res.response.status).toBe(403);
    expect(await weights()).toBe(before);
  });
});
