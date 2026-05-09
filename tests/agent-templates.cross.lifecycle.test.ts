import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { ADMIN_ACCOUNT_ID } from "@/utils/constants";
import { prisma } from "@/utils/prisma";
import {
  createTemplate,
  deleteTemplate,
  getTemplate,
  hashedSlugFor,
  listTemplates,
  patchTemplate,
  publishTemplate,
  startAgentTemplatesServer,
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
    const server = await startAgentTemplatesServer(4021);
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

  test("publish locks delete, archive hides from list, and hashed-slug GET stays resolvable", async () => {
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

    const deleteAttempt = await deleteTemplate({
      baseURL,
      id: created.body.id as string,
    });

    expect(deleteAttempt.response.status).toBe(409);
    expect(JSON.stringify(deleteAttempt.body.error)).toContain(
      "firstPublishedAt",
    );
    expect(
      await prisma.agentTemplate.count({
        where: { id: created.body.id as string },
      }),
    ).toBe(1);

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
      path: hashedSlugFor(created.body),
    });

    expect(direct.response.status).toBe(200);
    expect(direct.body).toMatchObject({
      id: created.body.id,
      status: "archived",
    } satisfies Partial<TemplateBody>);
  });
});
