import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";
import { ADMIN_ACCOUNT_ID } from "@/utils/constants";
import { prisma } from "@/utils/prisma";
import {
  createTemplate,
  deleteTemplate,
  getTemplate,
  listTemplates,
  patchTemplate,
  publishTemplate,
  startAgentTemplatesServer,
  urlSlugFor,
  type TemplateBody,
} from "./agent-templates.cross.helpers";

let baseURL: string;
let closeServer: () => Promise<void>;

const cleanupTemplates = () =>
  prisma.agentTemplate.deleteMany({
    where: {
      ownerAccountId: ADMIN_ACCOUNT_ID,
      OR: [
        { slug: { startsWith: "cross-lifecycle-" } },
        { agentName: { startsWith: "Cross Lifecycle" } },
      ],
    },
  });

const expectListOmits = async (id: string) => {
  const listed = await listTemplates({ baseURL, query: "?limit=100" });

  expect(listed.response.status).toBe(200);
  expect(listed.body.data.map((row) => row.id)).not.toContain(id);
};

describe("Agent template cross lifecycle flow", () => {
  beforeAll(async () => {
    const server = await startAgentTemplatesServer(4068);
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

  test("publish → archive hides from list, hashed-slug GET stays resolvable, and DELETE succeeds in any state", async () => {
    const created = await createTemplate({
      baseURL,
      body: {
        agentName: "Cross Lifecycle Brew",
        prompt: "Keep track of the brew lifecycle",
        slug: "cross-lifecycle-brew",
      },
    });

    expect(created.response.status).toBe(201);
    expect(created.body.status).toBe("draft");

    const published = await publishTemplate({
      baseURL,
      id: created.body.id as string,
    });

    expect(published.response.status).toBe(200);
    expect(published.body.status).toBe("published");
    expect(published.body.firstPublishedAt).toEqual(expect.any(String));

    const archived = await patchTemplate({
      baseURL,
      id: created.body.id as string,
      body: { status: "archived" },
    });

    expect(archived.response.status).toBe(200);
    expect(archived.body.status).toBe("archived");
    expect(archived.body.firstPublishedAt).toBe(
      published.body.firstPublishedAt,
    );

    await expectListOmits(created.body.id as string);

    const direct = await getTemplate({
      baseURL,
      path: urlSlugFor(created.body),
    });

    expect(direct.response.status).toBe(200);
    expect(direct.body).toMatchObject({
      id: created.body.id,
      status: "archived",
    } satisfies Partial<TemplateBody>);

    // DELETE is now permitted in any publish state (see commit a0a6861 —
    // the previous ALREADY_PUBLISHED gate was removed). Owner accepts that
    // the canonical URL will start 404'ing.
    const deleted = await deleteTemplate({
      baseURL,
      id: created.body.id as string,
    });

    expect(deleted.response.status).toBe(200);
    expect(
      await prisma.agentTemplate.count({
        where: { id: created.body.id as string },
      }),
    ).toBe(0);
  });
});
