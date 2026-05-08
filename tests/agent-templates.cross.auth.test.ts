import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { prisma } from "@/utils/prisma";
import {
  agentKeyHeaders,
  createTemplate,
  jsonHeaders,
  jwtHeaders,
  startAgentTemplatesServer,
  validAgentAssetsApiKey,
} from "./agent-templates.cross.helpers";

let baseURL: string;
let closeServer: () => Promise<void>;
const originalAgentAssetsApiKey = process.env.AGENT_ASSETS_API_KEY;

const cleanupTemplates = () =>
  prisma.agentTemplate.deleteMany({
    where: {
      ownerAccountId: "acct_admin",
      OR: [
        { slug: { startsWith: "cross-auth-" } },
        { agentName: { startsWith: "Cross Auth" } },
      ],
    },
  });

const restoreAgentAssetsApiKey = () => {
  if (originalAgentAssetsApiKey === undefined) {
    delete process.env.AGENT_ASSETS_API_KEY;
    return;
  }

  process.env.AGENT_ASSETS_API_KEY = originalAgentAssetsApiKey;
};

describe("Agent template cross auth flow", () => {
  beforeAll(async () => {
    const server = await startAgentTemplatesServer(4022);
    baseURL = server.baseURL;
    closeServer = server.close;
  });

  afterAll(async () => {
    restoreAgentAssetsApiKey();
    await cleanupTemplates();
    await closeServer();
  });

  beforeEach(async () => {
    process.env.AGENT_ASSETS_API_KEY = validAgentAssetsApiKey;
    await cleanupTemplates();
  });

  test("JWT and agent API key create equivalent draft rows while unauthenticated POST is rejected", async () => {
    const jwtCreated = await createTemplate({
      baseURL,
      headers: await jwtHeaders(),
      body: {
        agentName: "Cross Auth Jwt",
        prompt: "Created with JWT",
        slug: "cross-auth-jwt",
      },
    });

    const keyCreated = await createTemplate({
      baseURL,
      headers: agentKeyHeaders(),
      body: {
        agentName: "Cross Auth Key",
        prompt: "Created with agent key",
        slug: "cross-auth-key",
      },
    });

    expect(jwtCreated.response.status).toBe(201);
    expect(keyCreated.response.status).toBe(201);
    expect(jwtCreated.body).toMatchObject({
      object: "agent_template",
      ownerAccountId: "acct_admin",
      status: "draft",
      version: 1,
    });
    expect(keyCreated.body).toMatchObject({
      object: "agent_template",
      ownerAccountId: "acct_admin",
      status: "draft",
      version: 1,
    });
    expect(jwtCreated.body.id).not.toBe(keyCreated.body.id);

    const rows = await prisma.agentTemplate.findMany({
      where: {
        id: {
          in: [jwtCreated.body.id as string, keyCreated.body.id as string],
        },
      },
      orderBy: { slug: "asc" },
      select: { id: true, ownerAccountId: true, status: true },
    });
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.ownerAccountId === "acct_admin")).toBe(true);
    expect(rows.every((row) => row.status === "draft")).toBe(true);

    const missingAuth = await createTemplate({
      baseURL,
      headers: jsonHeaders,
      body: {
        agentName: "Cross Auth None",
        prompt: "Should not persist",
        slug: "cross-auth-none",
      },
    });

    expect(missingAuth.response.status).toBe(401);
    expect(
      await prisma.agentTemplate.count({
        where: { slug: "cross-auth-none" },
      }),
    ).toBe(0);
  });
});
