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
  issueConnectionGrant,
  revokeConnectionGrantsByNaturalKey,
} from "@/api/v2/connections/v1-grant-adapter";
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

// The googlecalendar action slugs Composio's LIVE catalog exposes — the
// validity source the exec matcher checks (invalid_action vs no_grant). This
// stands in for `composio.tools.getRawComposioTools`. It deliberately includes
// real-but-UNBUNDLED slugs (e.g. GOOGLECALENDAR_CALENDARS_DELETE) so the suite
// can prove a real slug we don't bundle is no_grant, never invalid_action.
const STUB_GOOGLECALENDAR_CATALOG_SLUGS = [
  "GOOGLECALENDAR_EVENTS_LIST",
  "GOOGLECALENDAR_CREATE_EVENT",
  "GOOGLECALENDAR_UPDATE_EVENT",
  "GOOGLECALENDAR_DELETE_EVENT",
  "GOOGLECALENDAR_CALENDARS_DELETE",
  "GOOGLECALENDAR_FIND_FREE_SLOTS",
];

// Minimal Composio stub: exec touches tools.execute, tools.getRawComposioTools
// (slug-validity catalog), toolkits.get (version pinning) and (when a grant
// pins no connection) connectedAccounts.list.
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
    catalogSlugs?: string[];
    catalogThrows?: boolean;
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
      getRawComposioTools: (query: { toolkits?: string[] }) => {
        if (opts.catalogThrows) {
          return Promise.reject(new Error("Composio catalog unavailable"));
        }
        const toolkit = (query.toolkits ?? [])[0]?.toLowerCase();
        const slugs =
          toolkit === "googlecalendar"
            ? (opts.catalogSlugs ?? STUB_GOOGLECALENDAR_CATALOG_SLUGS)
            : (opts.catalogSlugs ?? []);
        return Promise.resolve(slugs.map((slug) => ({ slug })));
      },
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

// Grant seeding goes through the V1-adapter path (the same service functions
// the /v2/connections handlers call), which writes the legacy ConnectionGrant
// row AND the entitlement tables that exec's checkEntitlement now reads.
// Seeding the legacy table directly would leave the new tables empty and every
// authorization test would fail for the wrong reason.
async function seedGrant(data: {
  ownerAccountId: string;
  ownerInboxId: string;
  granteeInboxId: string;
  conversationId: string;
  toolkit: string;
  actions?: string[];
  bundleIds?: string[];
  serviceVersion?: number;
  revokedAt?: Date;
}) {
  const grant = await issueConnectionGrant({
    accountId: data.ownerAccountId,
    ownerInboxId: data.ownerInboxId,
    granteeInboxId: data.granteeInboxId,
    conversationId: data.conversationId,
    toolkit: data.toolkit,
    actions: data.actions,
    bundleIds: data.bundleIds,
    serviceVersion: data.serviceVersion,
  });
  if (data.revokedAt) {
    await revokeConnectionGrantsByNaturalKey({
      accountId: data.ownerAccountId,
      toolkit: data.toolkit,
      conversationId: data.conversationId,
      granteeInboxId: data.granteeInboxId,
    });
  }
  return grant;
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
    await seedGrant({
      ownerAccountId,
      ownerInboxId: "owner-inbox",
      granteeInboxId: AGENT_INBOX,
      conversationId: CONVERSATION,
      toolkit: "googlecalendar",
      actions: [],
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
    await seedGrant({
      ownerAccountId,
      ownerInboxId: "owner-inbox",
      granteeInboxId: AGENT_INBOX,
      conversationId: CONVERSATION,
      toolkit: "googlecalendar",
      actions: [],
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
    await seedGrant({
      ownerAccountId,
      ownerInboxId: "owner-inbox",
      granteeInboxId: AGENT_INBOX,
      conversationId: CONVERSATION,
      toolkit: "googlecalendar",
      actions: [],
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
    await seedGrant({
      ownerAccountId,
      ownerInboxId: "owner-inbox",
      granteeInboxId: AGENT_INBOX,
      conversationId: CONVERSATION,
      toolkit: "googlecalendar",
      actions: [],
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
    await seedGrant({
      ownerAccountId,
      ownerInboxId: "owner-inbox",
      granteeInboxId: AGENT_INBOX,
      conversationId: CONVERSATION,
      toolkit: "googlecalendar",
      actions: ["GOOGLECALENDAR_EVENTS_LIST"],
    });
    installComposioStub();
    const res = await exec(
      { ...VALID_BODY, action: "GOOGLECALENDAR_DELETE_EVENT" },
      { headers: workerHeaders() },
    );
    expect(res.status).toBe(403);
    expect((await asJson<{ code: string }>(res)).code).toBe("no_grant");
  });

  // Backstop: a slug the toolkit never had is `invalid_action` (422), NOT a
  // consent gap (`no_grant`). This is the authoritative fix for the calendar
  // re-auth loop — a guessed/typo'd slug (observed live: "listEvents", the
  // retired "GOOGLECALENDAR_LIST_EVENTS") must never tell the agent to
  // re-prompt the user, even when the runtime slug guard is bypassed. A VALID
  // slug that simply isn't granted stays `no_grant` (the consent path).
  test("422 invalid_action when the slug is not in the toolkit catalog (even with a covering grant)", async () => {
    const ownerAccountId = await makeAccount();
    await seedGrant({
      ownerAccountId,
      ownerInboxId: "owner-inbox",
      granteeInboxId: AGENT_INBOX,
      conversationId: CONVERSATION,
      toolkit: "googlecalendar",
      actions: [],
      bundleIds: ["calendar.events"],
      serviceVersion: 5,
    });
    installComposioStub({
      connections: [
        { id: "conn_owned", userId: ownerAccountId, slug: "googlecalendar" },
      ],
    });
    // The exact strings the agent guessed during the incident — none is a real
    // GOOGLECALENDAR_* slug.
    for (const action of [
      "listEvents",
      "list_events",
      "getEvents",
      "GOOGLECALENDAR_LIST_EVENTS",
      "calendar.events.list",
    ]) {
      const res = await exec(
        { ...VALID_BODY, action },
        { headers: workerHeaders() },
      );
      expect(res.status).toBe(422);
      const body = await asJson<{ code: string; action: string }>(res);
      expect(body.code).toBe("invalid_action");
      expect(body.action).toBe(action);
    }
  });

  test("invalid_action takes precedence over no_grant: bad slug with NO grant is still 422, not 403", async () => {
    // No grant at all for this conversation; the slug is also bogus. The agent
    // must learn it named a non-existent action (fixable by itself), not that
    // it needs consent (which would re-prompt the user pointlessly).
    installComposioStub();
    const res = await exec(
      { ...VALID_BODY, action: "listEvents" },
      { headers: workerHeaders() },
    );
    expect(res.status).toBe(422);
    expect((await asJson<{ code: string }>(res)).code).toBe("invalid_action");
  });

  test("a VALID but ungranted slug stays no_grant (consent path preserved)", async () => {
    // No grant here, but GOOGLECALENDAR_EVENTS_LIST is a real catalog slug — so
    // this IS a consent gap and must remain no_grant, not invalid_action.
    installComposioStub();
    const res = await exec(
      { ...VALID_BODY, action: "GOOGLECALENDAR_EVENTS_LIST" },
      { headers: workerHeaders() },
    );
    expect(res.status).toBe(403);
    expect((await asJson<{ code: string }>(res)).code).toBe("no_grant");
  });

  // The decision the whole PR turns on: validity is sourced from Composio's LIVE
  // catalog, not our consent bundles. So a slug Composio really exposes but we
  // have NOT bundled (GOOGLECALENDAR_CALENDARS_DELETE) is a real action -> a
  // genuine consent gap (no_grant/403), while a slug Composio never had
  // (a typo) is invalid_action (422). Sourcing validity from bundles would
  // wrongly flip the real-but-unbundled slug to invalid_action — this locks
  // against that regression.
  test("catalog vs bundle: real-but-unbundled slug is no_grant; fake slug is invalid_action", async () => {
    installComposioStub();
    // Real Composio slug, not in any consent bundle, no grant -> consent gap.
    const realUnbundled = await exec(
      { ...VALID_BODY, action: "GOOGLECALENDAR_CALENDARS_DELETE" },
      { headers: workerHeaders() },
    );
    expect(realUnbundled.status).toBe(403);
    expect((await asJson<{ code: string }>(realUnbundled)).code).toBe(
      "no_grant",
    );

    // Slug Composio never exposed -> the agent named a non-existent action.
    const fake = await exec(
      { ...VALID_BODY, action: "GOOGLECALENDAR_TOTALLY_MADE_UP" },
      { headers: workerHeaders() },
    );
    expect(fake.status).toBe(422);
    expect((await asJson<{ code: string }>(fake)).code).toBe("invalid_action");
  });

  // Fail OPEN on a catalog outage: the slug-validity source is best-effort, NOT
  // a security boundary (the grant store is). If Composio's catalog throws or
  // returns nothing, we must NOT flag a real slug as invalid_action — that would
  // tell the agent to re-prompt the user during an outage (the re-auth loop).
  // The matcher skips the invalid_action check and falls through to the grant
  // check: a real ungranted slug stays no_grant, and exec never 500s.
  test("catalog THROW: a real ungranted slug is no_grant, not invalid_action (no 500)", async () => {
    installComposioStub({ catalogThrows: true });
    const res = await exec(
      { ...VALID_BODY, action: "GOOGLECALENDAR_EVENTS_LIST" },
      { headers: workerHeaders() },
    );
    expect(res.status).toBe(403);
    expect((await asJson<{ code: string }>(res)).code).toBe("no_grant");
  });

  test("empty catalog: a real ungranted slug is no_grant, not invalid_action", async () => {
    installComposioStub({ catalogSlugs: [] });
    const res = await exec(
      { ...VALID_BODY, action: "GOOGLECALENDAR_EVENTS_LIST" },
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
    await seedGrant({
      ownerAccountId,
      ownerInboxId: "owner-inbox",
      granteeInboxId: AGENT_INBOX,
      conversationId: CONVERSATION,
      toolkit: "googlecalendar",
      actions: [],
      bundleIds: ["calendar.events"],
      serviceVersion: 1,
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
    await seedGrant({
      ownerAccountId,
      ownerInboxId: "owner-inbox",
      granteeInboxId: AGENT_INBOX,
      conversationId: CONVERSATION,
      toolkit: "googlecalendar",
      actions: [],
      bundleIds: ["calendar.events"],
      serviceVersion: 1,
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
    await seedGrant({
      ownerAccountId,
      ownerInboxId: "owner-inbox",
      granteeInboxId: AGENT_INBOX,
      conversationId: CONVERSATION,
      toolkit: "googlecalendar",
      actions: [],
      bundleIds: ["calendar.bogus"],
      serviceVersion: 2,
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
    // calendar.events.read is DEPRECATED since googlecalendar v4 (hidden from
    // the public catalog) but real grants persist it — this test is the
    // backward-compat guarantee that those grants keep resolving to LIST,
    // and ONLY to LIST, at exec time.
    const ownerAccountId = await makeAccount();
    await seedGrant({
      ownerAccountId,
      ownerInboxId: "owner-inbox",
      granteeInboxId: AGENT_INBOX,
      conversationId: CONVERSATION,
      toolkit: "googlecalendar",
      actions: [],
      bundleIds: ["calendar.events.read"],
      serviceVersion: 2,
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
    await seedGrant({
      ownerAccountId,
      ownerInboxId: "owner-inbox",
      granteeInboxId: AGENT_INBOX,
      conversationId: CONVERSATION,
      toolkit: "googlecalendar",
      actions: [],
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
    await seedGrant({
      ownerAccountId,
      ownerInboxId: "owner-inbox",
      granteeInboxId: AGENT_INBOX,
      conversationId: CONVERSATION,
      toolkit: "googlecalendar",
      actions: [],
      revokedAt: new Date(),
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
        await seedGrant({
          ownerAccountId: accountId,
          ownerInboxId: inbox,
          granteeInboxId: AGENT_INBOX,
          conversationId: CONVERSATION,
          toolkit: "googlecalendar",
          actions: [],
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
