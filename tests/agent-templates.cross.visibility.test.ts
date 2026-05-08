import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { ADMIN_ACCOUNT_ID } from "@/utils/prefixed-id";
import { prisma } from "@/utils/prisma";
import {
  createTemplate,
  getTemplate,
  hashedSlugFor,
  listTemplates,
  patchTemplate,
  publishTemplate,
  startAgentTemplatesServer,
} from "./agent-templates.cross.helpers";

let baseURL: string;
let closeServer: () => Promise<void>;

const cleanupTemplates = () =>
  prisma.agentTemplate.deleteMany({
    where: {
      ownerAccountId: ADMIN_ACCOUNT_ID,
      OR: [
        { slug: { startsWith: "cross-visibility-" } },
        { agentName: { startsWith: "Cross Visibility" } },
      ],
    },
  });

const listContains = async (id: string) => {
  const listed = await listTemplates({ baseURL, query: "?limit=100" });

  expect(listed.response.status).toBe(200);

  return listed.body.data.some((row) => row.id === id);
};

describe("Agent template cross visibility flow", () => {
  beforeAll(async () => {
    const server = await startAgentTemplatesServer(4024);
    baseURL = server.baseURL;
    closeServer = server.close;
  });

  afterAll(async () => {
    await cleanupTemplates();
    await closeServer();
  });

  beforeEach(async () => {
    await cleanupTemplates();
  });

  test("draft is invisible, published is visible, and archived is list-hidden but directly resolvable", async () => {
    const created = await createTemplate({
      baseURL,
      body: {
        agentName: "Cross Visibility Template",
        prompt: "Show and hide me across states",
        slug: "cross-visibility-template",
      },
    });
    const id = created.body.id as string;
    const hashedSlug = hashedSlugFor(created.body);

    expect(created.response.status).toBe(201);
    expect(created.body.status).toBe("draft");
    expect(await listContains(id)).toBe(false);
    expect(
      (await getTemplate({ baseURL, path: hashedSlug })).response.status,
    ).toBe(404);

    const published = await publishTemplate({ baseURL, id });
    expect(published.response.status).toBe(200);
    expect(published.body.status).toBe("published");
    expect(published.body.firstPublishedAt).toEqual(expect.any(String));
    expect(await listContains(id)).toBe(true);

    const publishedDetail = await getTemplate({ baseURL, path: hashedSlug });
    expect(publishedDetail.response.status).toBe(200);
    expect(publishedDetail.body.status).toBe("published");

    const archived = await patchTemplate({
      baseURL,
      id,
      body: { status: "archived" },
    });
    expect(archived.response.status).toBe(200);
    expect(archived.body.status).toBe("archived");
    expect(await listContains(id)).toBe(false);

    const archivedDetail = await getTemplate({ baseURL, path: hashedSlug });
    expect(archivedDetail.response.status).toBe(200);
    expect(archivedDetail.body.status).toBe("archived");
  });
});
