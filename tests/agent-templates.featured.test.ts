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
  patchTemplate,
  startAgentTemplatesServer,
  validAgentAssetsApiKey,
} from "./agent-templates.cross.helpers";

// `featured` is gallery-curation state. It can be set at create time, and —
// since the admin templates dashboard added a per-row toggle — flipped via
// PATCH by an agent-key (admin) caller, independent of publish status.

let baseURL: string;
let closeServer: () => Promise<void>;

const cleanup = () =>
  prisma.agentTemplate.deleteMany({
    where: {
      ownerAccountId: ADMIN_ACCOUNT_ID,
      OR: [
        { slug: { startsWith: "featured-toggle-" } },
        { agentName: { startsWith: "Featured Toggle" } },
      ],
    },
  });

describe("Agent template featured toggle (admin PATCH)", () => {
  beforeAll(async () => {
    // Register the agent API key so X-Agent-API-Key auth resolves to ADMIN
    // instead of 503-ing (mirrors the other agent-key router tests).
    __setAgentAssetsApiKeyOverrideForTests(validAgentAssetsApiKey);
    const server = await startAgentTemplatesServer(4091);
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

  test("PATCH { featured } flips the flag and persists for an agent-key caller", async () => {
    const created = await createTemplate({
      baseURL,
      headers: agentKeyHeaders(),
      body: {
        agentName: "Featured Toggle Brew",
        prompt: "Curate the gallery",
        slug: "featured-toggle-brew",
      },
    });
    expect(created.response.status).toBe(201);
    expect(created.body.featured).toBe(false);
    const id = created.body.id as string;

    // Turn it on.
    const on = await patchTemplate({
      baseURL,
      id,
      headers: agentKeyHeaders(),
      body: { featured: true },
    });
    expect(on.response.status).toBe(200);
    expect(on.body.featured).toBe(true);

    // …and back off.
    const off = await patchTemplate({
      baseURL,
      id,
      headers: agentKeyHeaders(),
      body: { featured: false },
    });
    expect(off.response.status).toBe(200);
    expect(off.body.featured).toBe(false);

    // Persisted, not just echoed back from the patch handler.
    const fetched = await getTemplate({
      baseURL,
      path: id,
      headers: agentKeyHeaders(),
    });
    expect(fetched.body.featured).toBe(false);
  });

  test("featured can be set at create time too", async () => {
    const created = await createTemplate({
      baseURL,
      headers: agentKeyHeaders(),
      body: {
        agentName: "Featured Toggle Seed",
        prompt: "Seeded as featured",
        slug: "featured-toggle-seed",
        featured: true,
      },
    });
    expect(created.response.status).toBe(201);
    expect(created.body.featured).toBe(true);
  });
});
