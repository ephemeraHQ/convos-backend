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
  listTemplates,
  publishTemplate,
  startAgentTemplatesServer,
} from "./agent-templates.cross.helpers";

let baseURL: string;
let closeServer: () => Promise<void>;

const category = "cross-pagination-category";

const cleanupTemplates = () =>
  prisma.agentTemplate.deleteMany({
    where: {
      ownerAccountId: ADMIN_ACCOUNT_ID,
      OR: [
        { category },
        { slug: { startsWith: "cross-pagination-" } },
        { agentName: { startsWith: "Cross Pagination" } },
      ],
    },
  });

describe("Agent template cross pagination flow", () => {
  beforeAll(async () => {
    const server = await startAgentTemplatesServer(4025);
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

  test("cursor pagination across 25 published rows returns 10 + 10 + 5 with no duplicates", async () => {
    const seededIds: string[] = [];

    for (let index = 1; index <= 25; index++) {
      const created = await createTemplate({
        baseURL,
        body: {
          agentName: `Cross Pagination ${index}`,
          prompt: `Pagination prompt ${index}`,
          slug: `cross-pagination-${index}`,
          category,
        },
      });
      expect(created.response.status).toBe(201);

      const published = await publishTemplate({
        baseURL,
        id: created.body.id as string,
      });
      expect(published.response.status).toBe(200);
      seededIds.push(created.body.id as string);
    }

    const first = await listTemplates({
      baseURL,
      query: `?limit=10&category=${category}`,
    });
    const firstCursor = String(first.body.nextCursor);

    const second = await listTemplates({
      baseURL,
      query: `?limit=10&category=${category}&cursor=${encodeURIComponent(
        firstCursor,
      )}`,
    });
    const secondCursor = String(second.body.nextCursor);

    const third = await listTemplates({
      baseURL,
      query: `?limit=10&category=${category}&cursor=${encodeURIComponent(
        secondCursor,
      )}`,
    });

    expect(first.response.status).toBe(200);
    expect(second.response.status).toBe(200);
    expect(third.response.status).toBe(200);
    expect(first.body.data).toHaveLength(10);
    expect(second.body.data).toHaveLength(10);
    expect(third.body.data).toHaveLength(5);
    expect(first.body.hasMore).toBe(true);
    expect(second.body.hasMore).toBe(true);
    expect(third.body.hasMore).toBe(false);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    expect(first.body.nextCursor).toEqual(expect.any(String));
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    expect(second.body.nextCursor).toEqual(expect.any(String));
    expect(second.body.nextCursor).not.toBe(firstCursor);
    expect(third.body.nextCursor).toBeNull();

    const returnedIds = [
      ...first.body.data,
      ...second.body.data,
      ...third.body.data,
    ].map((row) => row.id as string);
    const returnedSet = new Set(returnedIds);

    expect(returnedIds).toHaveLength(25);
    expect(returnedSet.size).toBe(25);
    expect(returnedSet).toEqual(new Set(seededIds));
  });
});
