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
import { buildSlug } from "@/utils/slug-hash";
import {
  createTemplate,
  getTemplate,
  hashedSlugFor,
  patchTemplate,
  publishTemplate,
  startAgentTemplatesServer,
} from "./agent-templates.cross.helpers";

let baseURL: string;
let closeServer: () => Promise<void>;

const reservedWords = [
  "generate",
  "publish",
  "fork",
  "search",
  "files",
  "templates",
  "skills",
] as const;

const cleanupTemplates = () =>
  prisma.agentTemplate.deleteMany({
    where: {
      ownerAccountId: ADMIN_ACCOUNT_ID,
      OR: [
        { slug: { in: ["brewski", "brewski-2"] } },
        { slug: { startsWith: "cross-reserved-" } },
        { slug: { in: reservedWords.flatMap((word) => [word, `${word}-2`]) } },
        { agentName: "Brewski" },
        { agentName: { startsWith: "Cross Reserved" } },
        {
          agentName: {
            in: reservedWords.map(
              (word) => word[0].toUpperCase() + word.slice(1),
            ),
          },
        },
      ],
    },
  });

describe("Agent template cross slug flow", () => {
  beforeAll(async () => {
    const server = await startAgentTemplatesServer(4072);
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

  test("duplicate agentName auto-suffixes, publishes, and hashed-slug URLs do not alias", async () => {
    const first = await createTemplate({
      baseURL,
      body: { agentName: "Brewski", prompt: "First brew helper" },
    });
    const second = await createTemplate({
      baseURL,
      body: { agentName: "Brewski", prompt: "Second brew helper" },
    });

    expect(first.response.status).toBe(201);
    expect(second.response.status).toBe(201);
    expect(first.body.slug).toBe("brewski");
    expect(second.body.slug).toBe("brewski-2");
    expect(first.body.id).not.toBe(second.body.id);

    expect(
      (await publishTemplate({ baseURL, id: first.body.id as string })).response
        .status,
    ).toBe(200);
    expect(
      (await publishTemplate({ baseURL, id: second.body.id as string }))
        .response.status,
    ).toBe(200);

    const firstDirect = await getTemplate({
      baseURL,
      path: hashedSlugFor(first.body),
    });
    const secondDirect = await getTemplate({
      baseURL,
      path: hashedSlugFor(second.body),
    });
    const crossAliased = await getTemplate({
      baseURL,
      path: buildSlug(first.body.slug as string, second.body.id as string),
    });

    expect(firstDirect.response.status).toBe(200);
    expect(firstDirect.body.id).toBe(first.body.id);
    expect(secondDirect.response.status).toBe(200);
    expect(secondDirect.body.id).toBe(second.body.id);
    expect(crossAliased.response.status).toBe(404);
  });

  test("auto-derived reserved words are rejected with 400 RESERVED_SLUG", async () => {
    for (const word of reservedWords) {
      const agentName = word[0].toUpperCase() + word.slice(1);
      const created = await createTemplate({
        baseURL,
        body: {
          agentName,
          prompt: `Reserved word ${word} should be rejected`,
        },
      });

      expect(created.response.status).toBe(400);
      expect(created.body.error).toMatchObject({ code: "RESERVED_SLUG" });
    }
  });

  test("reserved slugs are rejected on explicit POST and every slug-changing PATCH surface", async () => {
    for (const word of reservedWords) {
      const explicit = await createTemplate({
        baseURL,
        body: {
          agentName: `Cross Reserved Explicit ${word}`,
          prompt: "Should be rejected",
          slug: word,
        },
      });

      expect(explicit.response.status).toBe(400);
      expect(explicit.body.error).toMatchObject({ code: "RESERVED_SLUG" });
    }

    const draft = await createTemplate({
      baseURL,
      body: {
        agentName: "Cross Reserved Patch",
        prompt: "Stay a draft for slug patching",
        slug: "cross-reserved-patch",
      },
    });
    expect(draft.response.status).toBe(201);

    for (const word of reservedWords) {
      const patched = await patchTemplate({
        baseURL,
        id: draft.body.id as string,
        body: { slug: word },
      });
      const row = await prisma.agentTemplate.findUniqueOrThrow({
        where: { id: draft.body.id as string },
      });

      expect(patched.response.status).toBe(400);
      expect(patched.body.error).toMatchObject({ code: "RESERVED_SLUG" });
      expect(row.slug).toBe("cross-reserved-patch");
    }
  });
});
