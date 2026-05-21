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
import { prisma } from "@/utils/prisma";
import {
  agentKeyHeaders,
  createTemplate,
  startAgentTemplatesServer,
  validAgentAssetsApiKey,
} from "./agent-templates.cross.helpers";

// forkedFromId coverage for POST /api/v2/agent-templates. The runtime sets it
// when publishing forks an adopted catalog template, so the new row records
// the source it was copied from.

const SOURCE_ID = "00000000-0000-4000-8000-cccccccc0fc1";
const NONEXISTENT_ID = "00000000-0000-4000-8000-deaddead0fc1";
const TEST_PORT = 4089;

let baseURL: string;
let closeServer: () => Promise<void>;

const cleanup = () =>
  prisma.agentTemplate.deleteMany({
    where: {
      ownerAccountId: ADMIN_ACCOUNT_ID,
      slug: { startsWith: "create-fork-test-" },
    },
  });

describe("Agent template create — forkedFromId", () => {
  beforeAll(async () => {
    __setAgentAssetsApiKeyOverrideForTests(validAgentAssetsApiKey);
    // A persistent source row to fork from. Its slug intentionally does NOT
    // match the per-test cleanup prefix, so beforeEach won't delete it.
    await prisma.agentTemplate.upsert({
      where: { id: SOURCE_ID },
      update: {},
      create: {
        id: SOURCE_ID,
        slug: "fork-source-fixture",
        ownerAccountId: ADMIN_ACCOUNT_ID,
        agentName: "Fork Source",
        prompt: "You are the source",
        tools: [],
        connections: [],
        version: 1,
        status: "published",
        featured: false,
      },
    });
    const server = await startAgentTemplatesServer(TEST_PORT);
    baseURL = server.baseURL;
    closeServer = server.close;
  });

  afterAll(async () => {
    await cleanup();
    await prisma.agentTemplate
      .delete({ where: { id: SOURCE_ID } })
      .catch(() => {
        /* idempotent */
      });
    __setAgentAssetsApiKeyOverrideForTests(undefined);
    await closeServer();
  });

  beforeEach(cleanup);

  test("records forkedFromId when it references an existing template", async () => {
    const { body, response } = await createTemplate({
      baseURL,
      headers: agentKeyHeaders(),
      body: {
        agentName: "Fork Test A",
        prompt: "You are a fork",
        slug: "create-fork-test-a",
        forkedFromId: SOURCE_ID,
      },
    });

    expect(response.status).toBe(201);
    expect(body.forkedFromId).toBe(SOURCE_ID);

    const row = await prisma.agentTemplate.findUniqueOrThrow({
      where: { id: body.id as string },
    });
    expect(row.forkedFromId).toBe(SOURCE_ID);
  });

  test("defaults forkedFromId to null when omitted", async () => {
    const { body, response } = await createTemplate({
      baseURL,
      headers: agentKeyHeaders(),
      body: {
        agentName: "Fork Test B",
        prompt: "plain",
        slug: "create-fork-test-b",
      },
    });

    expect(response.status).toBe(201);
    expect(body.forkedFromId).toBeNull();
  });

  test("rejects a forkedFromId that does not exist with 400", async () => {
    const { body, response } = await createTemplate({
      baseURL,
      headers: agentKeyHeaders(),
      body: {
        agentName: "Fork Test C",
        prompt: "x",
        slug: "create-fork-test-c",
        forkedFromId: NONEXISTENT_ID,
      },
    });

    expect(response.status).toBe(400);
    expect((body.error as string).toLowerCase()).toContain("forkedfromid");

    const rows = await prisma.agentTemplate.findMany({
      where: { ownerAccountId: ADMIN_ACCOUNT_ID, slug: "create-fork-test-c" },
    });
    expect(rows).toHaveLength(0);
  });
});
