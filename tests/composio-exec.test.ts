import type { Server } from "node:http";
import express from "express";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import { composioRouter } from "@/api/v2/composio/composio.router";
import {
  AGENT_INBOX_ID_HEADER,
  CONVERSATION_ID_HEADER,
} from "@/api/v2/composio/trusted-identity";
import {
  __resetComposioServiceForTests,
  ComposioService,
} from "@/api/v2/connections/composio.service";
import {
  __setComposioExecApiKeyOverrideForTests,
  COMPOSIO_EXEC_API_KEY_HEADER,
  composioExecAuth,
} from "@/middleware/agentAuth";
import { jsonMiddleware } from "@/middleware/json";
import { pinoMiddleware } from "@/middleware/pino";
import { prisma } from "@/utils/prisma";

vi.mock("firebase-admin/app");
vi.mock("firebase-admin/app-check");
vi.mock("firebase-admin/messaging");

const EXEC_KEY = "x".repeat(40);
const AGENT_INBOX = "agent-inbox-1";
const CONVERSATION = "conv-1";

const app = express();
app.use(pinoMiddleware);
app.use(jsonMiddleware);
app.use("/api/v2/composio", composioExecAuth, composioRouter);

let server: Server;
const baseURL = "http://localhost:4014";

// The toolkit version the stub publishes; exec must pin it on every execute.
const STUB_TOOLKIT_VERSION = "20260429_00";

// Minimal Composio stub: exec touches tools.execute, toolkits.get (version
// pinning) and (when a grant pins no connection) connectedAccounts.list.
function installComposioStub(
  opts: {
    execute?: (
      slug: string,
      body: {
        userId: string;
        connectedAccountId?: string;
        version?: string;
      },
    ) => Promise<unknown>;
    connections?: Array<{ id: string; userId: string; slug: string }>;
    toolkitVersions?: string[];
  } = {},
) {
  const stub = {
    tools: {
      execute:
        opts.execute ??
        ((
          _slug: string,
          _body: { userId: string; connectedAccountId?: string },
        ) => Promise.resolve({ data: { ok: true } })),
    },
    toolkits: {
      get: (_slug: string) =>
        Promise.resolve({
          meta: {
            availableVersions: opts.toolkitVersions ?? [STUB_TOOLKIT_VERSION],
          },
        }),
    },
    connectedAccounts: {
      list: (query: { userIds?: string[] }) => {
        const wanted = query.userIds ?? [];
        const items = (opts.connections ?? [])
          .filter((c) => wanted.includes(c.userId))
          .map((c) => ({ id: c.id, toolkit: { slug: c.slug } }));
        return Promise.resolve({ items, totalPages: 1, nextCursor: null });
      },
    },
  };
  __resetComposioServiceForTests(
    new ComposioService({
      composio: stub as unknown as ConstructorParameters<
        typeof ComposioService
      >[0]["composio"],
    }),
  );
}

// In production these headers are stamped by the trusted assistants worker
// (which alone holds the agent API key); the container never sets them.
function workerHeaders(
  caller: { conversationId?: string; agentInboxId?: string } = {
    conversationId: CONVERSATION,
    agentInboxId: AGENT_INBOX,
  },
): Record<string, string> {
  return {
    ...(caller.conversationId
      ? { [CONVERSATION_ID_HEADER]: caller.conversationId }
      : {}),
    ...(caller.agentInboxId
      ? { [AGENT_INBOX_ID_HEADER]: caller.agentInboxId }
      : {}),
  };
}

function exec(
  body: unknown,
  opts: { key?: string | null; headers?: Record<string, string> } = {},
) {
  const key = opts.key === undefined ? EXEC_KEY : opts.key;
  return fetch(`${baseURL}/api/v2/composio/exec`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(key ? { [COMPOSIO_EXEC_API_KEY_HEADER]: key } : {}),
      ...(opts.headers ?? {}),
    },
    body: JSON.stringify(body),
  });
}

async function asJson<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

const VALID_BODY = {
  toolkit: "googlecalendar",
  action: "GOOGLECALENDAR_EVENTS_LIST",
  args: {},
};

beforeAll(async () => {
  __setComposioExecApiKeyOverrideForTests(EXEC_KEY);
  await new Promise<void>((resolve) => {
    server = app.listen(4014, () => {
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  __setComposioExecApiKeyOverrideForTests(undefined);
  __resetComposioServiceForTests(null);
});

afterEach(() => {
  __resetComposioServiceForTests(null);
});

// --- No DB required: auth, validation, and the fail-closed security boundary ---

describe("POST /v2/composio/exec — auth + fail-closed (no DB)", () => {
  test("401 without an agent API key", async () => {
    const res = await exec(VALID_BODY, { key: null });
    expect(res.status).toBe(401);
  });

  test("401 with a wrong agent API key", async () => {
    const res = await exec(VALID_BODY, { key: "wrong".repeat(10) });
    expect(res.status).toBe(401);
  });

  test("400 on an invalid body (missing action)", async () => {
    const res = await exec(
      { toolkit: "googlecalendar" },
      { headers: workerHeaders() },
    );
    expect(res.status).toBe(400);
    expect((await asJson<{ code: string }>(res)).code).toBe("invalid_request");
  });

  test("403 fail-closed when the worker identity headers are absent", async () => {
    const res = await exec(VALID_BODY);
    expect(res.status).toBe(403);
    expect((await asJson<{ code: string }>(res)).code).toBe(
      "trusted_identity_unavailable",
    );
  });

  test("403 fail-closed when only one identity header is present", async () => {
    const res = await exec(VALID_BODY, {
      headers: workerHeaders({ conversationId: CONVERSATION }),
    });
    expect(res.status).toBe(403);
    expect((await asJson<{ code: string }>(res)).code).toBe(
      "trusted_identity_unavailable",
    );
  });

  test("403 fail-closed on an oversized identity header", async () => {
    const res = await exec(VALID_BODY, {
      headers: workerHeaders({
        conversationId: "c".repeat(300),
        agentInboxId: AGENT_INBOX,
      }),
    });
    expect(res.status).toBe(403);
    expect((await asJson<{ code: string }>(res)).code).toBe(
      "trusted_identity_unavailable",
    );
  });

  test("agent-named body fields cannot substitute for the identity headers", async () => {
    // Even if the agent stuffs identity-looking fields into the body, exec
    // still fail-closes: resolution reads only the worker-stamped headers.
    const res = await exec({
      ...VALID_BODY,
      conversationId: CONVERSATION,
      granteeInboxId: AGENT_INBOX,
      accountId: "11111111-1111-4111-8111-111111111111",
    });
    expect(res.status).toBe(403);
    expect((await asJson<{ code: string }>(res)).code).toBe(
      "trusted_identity_unavailable",
    );
  });
});

// --- No DB required: toolkit version resolution (unit) ---

describe("ComposioService.resolveToolkitVersion (no DB)", () => {
  function makeService(
    get: (slug: string) => Promise<unknown>,
  ): ComposioService {
    const stub = { toolkits: { get } };
    return new ComposioService({
      composio: stub as unknown as ConstructorParameters<
        typeof ComposioService
      >[0]["composio"],
    });
  }

  test("resolves the NEWEST version (lexicographic max), not list order", async () => {
    const service = makeService(() =>
      Promise.resolve({
        meta: {
          availableVersions: ["20260427_00", "20260429_00", "20260422_01"],
        },
      }),
    );
    expect(await service.resolveToolkitVersion("googlecalendar")).toBe(
      "20260429_00",
    );
  });

  test("caches per toolkit and normalizes the slug case", async () => {
    let calls = 0;
    const service = makeService((slug) => {
      calls += 1;
      expect(slug).toBe("googlecalendar");
      return Promise.resolve({ meta: { availableVersions: ["20260429_00"] } });
    });
    expect(await service.resolveToolkitVersion("googlecalendar")).toBe(
      "20260429_00",
    );
    expect(await service.resolveToolkitVersion("GoogleCalendar")).toBe(
      "20260429_00",
    );
    expect(calls).toBe(1);
  });

  test("returns null when no versions are published — and does NOT cache the miss", async () => {
    let calls = 0;
    const service = makeService(() => {
      calls += 1;
      return Promise.resolve({
        meta:
          calls === 1
            ? { availableVersions: [] }
            : { availableVersions: ["20260429_00"] },
      });
    });
    expect(await service.resolveToolkitVersion("googlecalendar")).toBeNull();
    // A transient gap must not stick: the next call retries and succeeds.
    expect(await service.resolveToolkitVersion("googlecalendar")).toBe(
      "20260429_00",
    );
    expect(calls).toBe(2);
  });

  test("returns null when availableVersions is absent from the response", async () => {
    const service = makeService(() => Promise.resolve({ meta: {} }));
    expect(await service.resolveToolkitVersion("googlecalendar")).toBeNull();
  });

  test("execute forwards the pinned version to the SDK", async () => {
    let seen: { version?: string } | null = null;
    const stub = {
      tools: {
        execute: (_slug: string, body: { version?: string }) => {
          seen = body;
          return Promise.resolve({ data: {} });
        },
      },
    };
    const service = new ComposioService({
      composio: stub as unknown as ConstructorParameters<
        typeof ComposioService
      >[0]["composio"],
    });
    await service.execute({
      action: "GOOGLECALENDAR_EVENTS_LIST",
      userId: "acct-1",
      arguments: {},
      connectedAccountId: "conn-1",
      version: "20260429_00",
    });
    expect(seen).toMatchObject({ version: "20260429_00" });
  });
});

// --- DB-backed: requires the test Postgres (pnpm test:local) ---

describe("POST /v2/composio/exec — grant authorization (DB)", () => {
  const accountIds: string[] = [];

  async function makeAccount(): Promise<string> {
    const account = await prisma.account.create({ data: {} });
    accountIds.push(account.id);
    return account.id;
  }

  afterEach(async () => {
    await prisma.connectionGrant.deleteMany({
      where: { ownerAccountId: { in: accountIds } },
    });
    await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
    accountIds.length = 0;
  });

  test("executes when a live grant matches — connection resolved server-side", async () => {
    const ownerAccountId = await makeAccount();
    await prisma.connectionGrant.create({
      data: {
        ownerAccountId,
        ownerInboxId: "owner-inbox",
        granteeInboxId: AGENT_INBOX,
        conversationId: CONVERSATION,
        toolkit: "googlecalendar",
        actions: [],
      },
    });
    let seen: {
      userId: string;
      connectedAccountId?: string;
      version?: string;
    } | null = null;
    installComposioStub({
      execute: (_slug, body) => {
        seen = body;
        return Promise.resolve({ data: { events: [] } });
      },
      connections: [
        { id: "conn_owned", userId: ownerAccountId, slug: "googlecalendar" },
      ],
    });

    const res = await exec(VALID_BODY, { headers: workerHeaders() });
    expect(res.status).toBe(200);
    expect((await asJson<{ data: unknown }>(res)).data).toEqual({ events: [] });
    // Composio is called with the OWNER's accountId, a connection resolved
    // from that account — never a client-supplied id — and the toolkit's
    // current version pinned (manual exec rejects implicit "latest").
    expect(seen).toMatchObject({
      userId: ownerAccountId,
      connectedAccountId: "conn_owned",
      version: STUB_TOOLKIT_VERSION,
    });
  });

  test("502 toolkit_version_unresolved when Composio reports no versions — fail closed", async () => {
    const ownerAccountId = await makeAccount();
    await prisma.connectionGrant.create({
      data: {
        ownerAccountId,
        ownerInboxId: "owner-inbox",
        granteeInboxId: AGENT_INBOX,
        conversationId: CONVERSATION,
        toolkit: "googlecalendar",
        actions: [],
      },
    });
    let executed = false;
    installComposioStub({
      execute: () => {
        executed = true;
        return Promise.resolve({ data: {} });
      },
      connections: [
        { id: "conn_owned", userId: ownerAccountId, slug: "googlecalendar" },
      ],
      toolkitVersions: [],
    });

    const res = await exec(VALID_BODY, { headers: workerHeaders() });
    expect(res.status).toBe(502);
    expect((await asJson<{ code: string }>(res)).code).toBe(
      "toolkit_version_unresolved",
    );
    // Fail closed means the tool is never executed unversioned.
    expect(executed).toBe(false);
  });

  test("a client-supplied connection id in the body is ignored (#2)", async () => {
    const ownerAccountId = await makeAccount();
    await prisma.connectionGrant.create({
      data: {
        ownerAccountId,
        ownerInboxId: "owner-inbox",
        granteeInboxId: AGENT_INBOX,
        conversationId: CONVERSATION,
        toolkit: "googlecalendar",
        actions: [],
      },
    });
    let seen: { connectedAccountId?: string } | null = null;
    installComposioStub({
      execute: (_slug, body) => {
        seen = body;
        return Promise.resolve({ data: {} });
      },
      connections: [
        { id: "conn_owned", userId: ownerAccountId, slug: "googlecalendar" },
      ],
    });
    // The agent tries to smuggle a foreign connection id; exec must ignore it
    // and use the owner's own resolved connection.
    const res = await exec(
      {
        ...VALID_BODY,
        connectionId: "ca_victim",
        connectedAccountId: "ca_victim",
      },
      { headers: workerHeaders() },
    );
    expect(res.status).toBe(200);
    expect(seen).toMatchObject({ connectedAccountId: "conn_owned" });
  });

  test("403 no_grant when the agent holds no grant here", async () => {
    installComposioStub();
    const res = await exec(VALID_BODY, { headers: workerHeaders() });
    expect(res.status).toBe(403);
    expect((await asJson<{ code: string }>(res)).code).toBe("no_grant");
  });

  test("403 no_grant for the same agent in a DIFFERENT conversation", async () => {
    const ownerAccountId = await makeAccount();
    await prisma.connectionGrant.create({
      data: {
        ownerAccountId,
        ownerInboxId: "owner-inbox",
        granteeInboxId: AGENT_INBOX,
        conversationId: CONVERSATION,
        toolkit: "googlecalendar",
        actions: [],
      },
    });
    installComposioStub();
    const res = await exec(VALID_BODY, {
      headers: workerHeaders({
        conversationId: "conv-other",
        agentInboxId: AGENT_INBOX,
      }),
    });
    expect(res.status).toBe(403);
    expect((await asJson<{ code: string }>(res)).code).toBe("no_grant");
  });

  test("403 no_grant when the action is outside the granted scope", async () => {
    const ownerAccountId = await makeAccount();
    await prisma.connectionGrant.create({
      data: {
        ownerAccountId,
        ownerInboxId: "owner-inbox",
        granteeInboxId: AGENT_INBOX,
        conversationId: CONVERSATION,
        toolkit: "googlecalendar",
        actions: ["GOOGLECALENDAR_EVENTS_LIST"],
      },
    });
    installComposioStub();
    const res = await exec(
      { ...VALID_BODY, action: "GOOGLECALENDAR_DELETE_EVENT" },
      { headers: workerHeaders() },
    );
    expect(res.status).toBe(403);
    expect((await asJson<{ code: string }>(res)).code).toBe("no_grant");
  });

  // Bundle scope: a grant carrying bundleIds authorizes exactly the actions the
  // bundle resolves to (resolveBundleActions against the current catalog) — no
  // more. In-bundle actions are allowed, out-of-bundle actions are no_grant,
  // a read-only bundle never authorizes a write, and unresolvable bundle ids
  // fail CLOSED (never the whole-toolkit transition default).
  test("bundle scope: an action inside the granted bundle is allowed", async () => {
    const ownerAccountId = await makeAccount();
    await prisma.connectionGrant.create({
      data: {
        ownerAccountId,
        ownerInboxId: "owner-inbox",
        granteeInboxId: AGENT_INBOX,
        conversationId: CONVERSATION,
        toolkit: "googlecalendar",
        actions: [],
        bundleIds: ["calendar.events"],
        serviceVersion: 1,
      },
    });
    installComposioStub({
      connections: [
        { id: "conn_owned", userId: ownerAccountId, slug: "googlecalendar" },
      ],
    });
    const res = await exec(
      { ...VALID_BODY, action: "GOOGLECALENDAR_CREATE_EVENT" },
      { headers: workerHeaders() },
    );
    expect(res.status).toBe(200);
  });

  test("bundle scope: an action outside the granted bundle is no_grant", async () => {
    const ownerAccountId = await makeAccount();
    await prisma.connectionGrant.create({
      data: {
        ownerAccountId,
        ownerInboxId: "owner-inbox",
        granteeInboxId: AGENT_INBOX,
        conversationId: CONVERSATION,
        toolkit: "googlecalendar",
        actions: [],
        bundleIds: ["calendar.events"],
        serviceVersion: 1,
      },
    });
    installComposioStub({
      connections: [
        { id: "conn_owned", userId: ownerAccountId, slug: "googlecalendar" },
      ],
    });
    // Not in the calendar.events bundle's action list.
    const res = await exec(
      { ...VALID_BODY, action: "GOOGLECALENDAR_CALENDARS_DELETE" },
      { headers: workerHeaders() },
    );
    expect(res.status).toBe(403);
    expect((await asJson<{ code: string }>(res)).code).toBe("no_grant");
  });

  test("fail-closed: unresolvable bundleIds authorize NOTHING (codex exploit)", async () => {
    // The exploit: a grant whose bundleIds don't resolve against the catalog
    // used to fall through to the whole-toolkit transition default (fail-open).
    // It must now be inapplicable for EVERY action — read or write.
    const ownerAccountId = await makeAccount();
    await prisma.connectionGrant.create({
      data: {
        ownerAccountId,
        ownerInboxId: "owner-inbox",
        granteeInboxId: AGENT_INBOX,
        conversationId: CONVERSATION,
        toolkit: "googlecalendar",
        actions: [],
        bundleIds: ["calendar.bogus"],
        serviceVersion: 2,
      },
    });
    installComposioStub({
      connections: [
        { id: "conn_owned", userId: ownerAccountId, slug: "googlecalendar" },
      ],
    });
    for (const action of [
      "GOOGLECALENDAR_EVENTS_LIST",
      "GOOGLECALENDAR_DELETE_EVENT",
    ]) {
      const res = await exec(
        { ...VALID_BODY, action },
        { headers: workerHeaders() },
      );
      expect(res.status).toBe(403);
      expect((await asJson<{ code: string }>(res)).code).toBe("no_grant");
    }
  });

  test("read-only bundle: read is allowed, writes are no_grant", async () => {
    const ownerAccountId = await makeAccount();
    await prisma.connectionGrant.create({
      data: {
        ownerAccountId,
        ownerInboxId: "owner-inbox",
        granteeInboxId: AGENT_INBOX,
        conversationId: CONVERSATION,
        toolkit: "googlecalendar",
        actions: [],
        bundleIds: ["calendar.events.read"],
        serviceVersion: 2,
      },
    });
    installComposioStub({
      connections: [
        { id: "conn_owned", userId: ownerAccountId, slug: "googlecalendar" },
      ],
    });

    const read = await exec(
      { ...VALID_BODY, action: "GOOGLECALENDAR_EVENTS_LIST" },
      { headers: workerHeaders() },
    );
    expect(read.status).toBe(200);

    for (const action of [
      "GOOGLECALENDAR_CREATE_EVENT",
      "GOOGLECALENDAR_DELETE_EVENT",
    ]) {
      const res = await exec(
        { ...VALID_BODY, action },
        { headers: workerHeaders() },
      );
      expect(res.status).toBe(403);
      expect((await asJson<{ code: string }>(res)).code).toBe("no_grant");
    }
  });

  test("legacy transition: no actions AND no bundleIds still means whole-toolkit", async () => {
    // The transition default survives ONLY for true legacy grants (both scope
    // fields empty) — even a write action passes. Tightens once clients always
    // send bundleIds.
    const ownerAccountId = await makeAccount();
    await prisma.connectionGrant.create({
      data: {
        ownerAccountId,
        ownerInboxId: "owner-inbox",
        granteeInboxId: AGENT_INBOX,
        conversationId: CONVERSATION,
        toolkit: "googlecalendar",
        actions: [],
      },
    });
    installComposioStub({
      connections: [
        { id: "conn_owned", userId: ownerAccountId, slug: "googlecalendar" },
      ],
    });
    const res = await exec(
      { ...VALID_BODY, action: "GOOGLECALENDAR_DELETE_EVENT" },
      { headers: workerHeaders() },
    );
    expect(res.status).toBe(200);
  });

  test("403 no_grant once the grant is revoked", async () => {
    const ownerAccountId = await makeAccount();
    await prisma.connectionGrant.create({
      data: {
        ownerAccountId,
        ownerInboxId: "owner-inbox",
        granteeInboxId: AGENT_INBOX,
        conversationId: CONVERSATION,
        toolkit: "googlecalendar",
        actions: [],
        revokedAt: new Date(),
      },
    });
    installComposioStub();
    const res = await exec(VALID_BODY, { headers: workerHeaders() });
    expect(res.status).toBe(403);
    expect((await asJson<{ code: string }>(res)).code).toBe("no_grant");
  });

  describe("onBehalfOf owner selector (group queries)", () => {
    async function seedTwoOwners() {
      const alice = await makeAccount();
      const bob = await makeAccount();
      for (const [accountId, inbox] of [
        [alice, "alice-inbox"],
        [bob, "bob-inbox"],
      ] as const) {
        await prisma.connectionGrant.create({
          data: {
            ownerAccountId: accountId,
            ownerInboxId: inbox,
            granteeInboxId: AGENT_INBOX,
            conversationId: CONVERSATION,
            toolkit: "googlecalendar",
            actions: [],
          },
        });
      }
      return { alice, bob };
    }

    test("409 ambiguous_grant when two owners shared and onBehalfOf is omitted", async () => {
      await seedTwoOwners();
      installComposioStub();
      const res = await exec(VALID_BODY, { headers: workerHeaders() });
      expect(res.status).toBe(409);
      expect((await asJson<{ code: string }>(res)).code).toBe(
        "ambiguous_grant",
      );
    });

    test("onBehalfOf selects that member's own connection", async () => {
      const { bob } = await seedTwoOwners();
      let seen: { userId: string; connectedAccountId?: string } | null = null;
      installComposioStub({
        execute: (_slug, body) => {
          seen = body;
          return Promise.resolve({ data: { ok: true } });
        },
        connections: [{ id: "conn_bob", userId: bob, slug: "googlecalendar" }],
      });
      const res = await exec(
        { ...VALID_BODY, onBehalfOf: "bob-inbox" },
        { headers: workerHeaders() },
      );
      expect(res.status).toBe(200);
      expect(seen).toMatchObject({
        userId: bob,
        connectedAccountId: "conn_bob",
      });
    });

    test("403 no_grant when onBehalfOf names a member who never granted", async () => {
      await seedTwoOwners();
      installComposioStub();
      const res = await exec(
        { ...VALID_BODY, onBehalfOf: "carol-inbox" },
        { headers: workerHeaders() },
      );
      expect(res.status).toBe(403);
      expect((await asJson<{ code: string }>(res)).code).toBe("no_grant");
    });
  });
});
