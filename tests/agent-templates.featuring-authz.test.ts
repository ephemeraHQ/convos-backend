import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";
import { __setAgentAssetsApiKeyOverrideForTests } from "@/middleware/agentAuth";
import { createJwtToken } from "@/utils/jwt";
import { prisma } from "@/utils/prisma";
import {
  agentKeyHeaders,
  startAgentTemplatesServer,
  validAgentAssetsApiKey,
} from "./agent-templates.cross.helpers";

// The featured gallery is the homepage's, not the template owner's. These pin
// the whole path shut: an ordinary signed-in user could otherwise mint a
// self-featured template, publish it (owners may publish their own), and appear
// in the gallery convos.org renders. They couldn't pick a slot — that was
// already gated — but being in the gallery at all is the front door.

// A plain punter: not the admin account, no API key.
const USER = "00000000-0000-4000-8000-eeeeeeee0001";

let baseURL: string;
let close: () => Promise<void>;

const userHeaders = async () => ({
  "Content-Type": "application/json",
  "X-Convos-AuthToken": await createJwtToken({
    deviceId: "featuring-authz-device",
    accountId: USER,
  }),
});

const create = async (
  headers: Record<string, string>,
  body: Record<string, unknown>,
) => {
  const response = await fetch(`${baseURL}/api/v2/agent-templates`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  return { response, body: (await response.json()) as Record<string, unknown> };
};

const patch = async (
  headers: Record<string, string>,
  id: string,
  body: Record<string, unknown>,
) => {
  const response = await fetch(`${baseURL}/api/v2/agent-templates/${id}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify(body),
  });
  return { response, body: (await response.json()) as Record<string, unknown> };
};

const featuredOf = async (id: string) =>
  (
    await prisma.agentTemplate.findUniqueOrThrow({
      where: { id },
      select: { featured: true },
    })
  ).featured;

describe("Featuring is the dashboard's, not the owner's", () => {
  beforeAll(async () => {
    __setAgentAssetsApiKeyOverrideForTests(validAgentAssetsApiKey);
    await prisma.account.upsert({
      where: { id: USER },
      create: { id: USER },
      update: {},
    });
    const server = await startAgentTemplatesServer(4098);
    baseURL = server.baseURL;
    close = server.close;
  });

  afterAll(async () => {
    await prisma.agentTemplate.deleteMany({ where: { ownerAccountId: USER } });
    await close();
    __setAgentAssetsApiKeyOverrideForTests(undefined);
  });

  beforeEach(async () => {
    await prisma.agentTemplate.deleteMany({ where: { ownerAccountId: USER } });
  });

  test("a user can't create a template that is already featured", async () => {
    const headers = await userHeaders();
    const res = await create(headers, {
      agentName: "Self Featured",
      prompt: "p",
      slug: "authz-self-featured",
      featured: true,
    });
    expect(res.response.status).toBe(403);

    // And nothing was written.
    const rows = await prisma.agentTemplate.findMany({
      where: { ownerAccountId: USER },
    });
    expect(rows).toEqual([]);
  });

  test("a user can't feature their own template afterwards", async () => {
    const headers = await userHeaders();
    const created = await create(headers, {
      agentName: "Ordinary",
      prompt: "p",
      slug: "authz-ordinary",
    });
    const id = created.body.id as string;
    expect(await featuredOf(id)).toBe(false);

    const res = await patch(headers, id, { featured: true });
    expect(res.response.status).toBe(403);
    expect(await featuredOf(id)).toBe(false);
  });

  // The builder sends `featured: false` on every create, and withdrawing a
  // template from the homepage can only ever remove something from it.
  test("a user may still create with featured:false, and unfeature their own", async () => {
    const headers = await userHeaders();
    const created = await create(headers, {
      agentName: "Opts Out",
      prompt: "p",
      slug: "authz-opts-out",
      featured: false,
    });
    expect(created.response.status).toBe(201);
    const id = created.body.id as string;

    // The dashboard features it...
    const featured = await patch(agentKeyHeaders(), id, { featured: true });
    expect(featured.response.status).toBe(200);
    expect(await featuredOf(id)).toBe(true);

    // ...and the owner can take it back out.
    const withdrawn = await patch(headers, id, { featured: false });
    expect(withdrawn.response.status).toBe(200);
    expect(await featuredOf(id)).toBe(false);
  });

  test("the dashboard still features templates", async () => {
    const created = await create(agentKeyHeaders(), {
      agentName: "Curated",
      prompt: "p",
      slug: "authz-curated",
      featured: true,
      ownerAccountId: USER,
    });
    expect(created.response.status).toBe(201);
    expect(await featuredOf(created.body.id as string)).toBe(true);
  });
});
