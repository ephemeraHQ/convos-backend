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
import { createJwtToken } from "@/utils/jwt";
import { prisma } from "@/utils/prisma";
import {
  agentKeyHeaders,
  createTemplate,
  startAgentTemplatesServer,
  validAgentAssetsApiKey,
} from "./agent-templates.cross.helpers";

// Owner-assertion coverage for POST /api/v2/agent-templates — mirrors the
// generations POST endpoint's contract. The runtime's assistant-builder
// create-then-publish fallback relies on this: a template minted on behalf of
// a joining user must land owned by that user, not the ADMIN seed account.

const ASSERTED_ACCOUNT_ID = "00000000-0000-4000-8000-cccccccc0aa1";
const NONEXISTENT_ACCOUNT_ID = "00000000-0000-4000-8000-deaddead0aa1";
const TEST_PORT = 4087;

let baseURL: string;
let closeServer: () => Promise<void>;

const cleanup = () =>
  prisma.agentTemplate.deleteMany({
    where: {
      ownerAccountId: { in: [ADMIN_ACCOUNT_ID, ASSERTED_ACCOUNT_ID] },
      slug: { startsWith: "create-owner-test-" },
    },
  });

describe("Agent template create — owner assertion", () => {
  beforeAll(async () => {
    __setAgentAssetsApiKeyOverrideForTests(validAgentAssetsApiKey);
    // Owner-assertion tests need a real account row to assert against.
    await prisma.account.upsert({
      where: { id: ASSERTED_ACCOUNT_ID },
      update: {},
      create: { id: ASSERTED_ACCOUNT_ID },
    });
    const server = await startAgentTemplatesServer(TEST_PORT);
    baseURL = server.baseURL;
    closeServer = server.close;
  });

  afterAll(async () => {
    await cleanup();
    await prisma.account
      .delete({ where: { id: ASSERTED_ACCOUNT_ID } })
      .catch(() => {
        /* idempotent */
      });
    __setAgentAssetsApiKeyOverrideForTests(undefined);
    await closeServer();
  });

  beforeEach(cleanup);

  test("agent-key auth + body.ownerAccountId → row owned by the asserted account", async () => {
    const { body, response } = await createTemplate({
      baseURL,
      headers: agentKeyHeaders(),
      body: {
        agentName: "Create Owner Test A",
        prompt: "You are helpful",
        slug: "create-owner-test-asserted",
        ownerAccountId: ASSERTED_ACCOUNT_ID,
      },
    });

    expect(response.status).toBe(201);
    expect(body.ownerAccountId).toBe(ASSERTED_ACCOUNT_ID);

    const row = await prisma.agentTemplate.findUniqueOrThrow({
      where: { id: body.id as string },
    });
    expect(row.ownerAccountId).toBe(ASSERTED_ACCOUNT_ID);
  });

  test("agent-key auth without assertion → row owner falls back to ADMIN", async () => {
    const { body, response } = await createTemplate({
      baseURL,
      headers: agentKeyHeaders(),
      body: {
        agentName: "Create Owner Test B",
        prompt: "You are helpful",
        slug: "create-owner-test-default",
      },
    });

    expect(response.status).toBe(201);
    expect(body.ownerAccountId).toBe(ADMIN_ACCOUNT_ID);
  });

  test("agent-key auth + nonexistent ownerAccountId → 400, no row created", async () => {
    const { body, response } = await createTemplate({
      baseURL,
      headers: agentKeyHeaders(),
      body: {
        agentName: "Create Owner Test C",
        prompt: "You are helpful",
        slug: "create-owner-test-missing",
        ownerAccountId: NONEXISTENT_ACCOUNT_ID,
      },
    });

    expect(response.status).toBe(400);
    expect((body.error as string).toLowerCase()).toContain("owneraccountid");

    const rows = await prisma.agentTemplate.findMany({
      where: { slug: "create-owner-test-missing" },
    });
    expect(rows).toHaveLength(0);
  });

  test("JWT auth + body.ownerAccountId → JWT account wins, body field ignored", async () => {
    const jwt = await createJwtToken({
      deviceId: "create-owner-jwt",
      accountId: ASSERTED_ACCOUNT_ID,
    });
    // Body asserts ADMIN — must be ignored because JWT auth wins.
    const { body, response } = await createTemplate({
      baseURL,
      headers: {
        "Content-Type": "application/json",
        "X-Convos-AuthToken": jwt,
      },
      body: {
        agentName: "Create Owner Test D",
        prompt: "You are helpful",
        slug: "create-owner-test-jwt",
        ownerAccountId: ADMIN_ACCOUNT_ID,
      },
    });

    expect(response.status).toBe(201);
    expect(body.ownerAccountId).toBe(ASSERTED_ACCOUNT_ID);
  });
});
