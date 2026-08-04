import { readFileSync } from "node:fs";
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
import v2Router from "@/api/v2";
import { __setEntitlementReadReadinessForTests } from "@/api/v2/abilities/read-readiness";
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
} from "@/middleware/agentAuth";
import { jsonMiddleware } from "@/middleware/json";
import { pinoMiddleware } from "@/middleware/pino";
import { createJwtToken, validateJWTKeys } from "@/utils/jwt";
import { prisma } from "@/utils/prisma";

vi.mock("firebase-admin/app");
vi.mock("firebase-admin/app-check");
vi.mock("firebase-admin/messaging");

const EXEC_KEY = "x".repeat(40);
const AGENT_INBOX = "agent-inbox-enum";
const CONVERSATION = "conv-enum";

// The PRODUCTION v2 router, not a handcrafted route: this suite must pin the
// real mount — order (the worker route declared before the JWT-gated
// /abilities subtree), shadowing, and the reserved-path behavior of
// "entitlements" against the /:abilityId client routes.
const app = express();
app.use(pinoMiddleware);
app.use(jsonMiddleware);
app.use("/api/v2", v2Router);

let server: Server;
const baseURL = "http://localhost:4016";

// The wire shape under test. TypeScript-only convenience for the assertions
// below; the serialized contract itself is pinned at runtime against
// docs/schemas/abilities-entitlements-worker.schema.json by the schema
// shape-pin test.
type EnumerateResponse = {
  abilities: Array<{
    abilityId: string;
    owners: Array<{ ownerInboxId: string | null; actions: string[] }>;
  }>;
};

// In production these headers are stamped by the trusted assistants worker
// (which alone holds the exec key); the container never sets them.
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

function enumerate(
  opts: { key?: string | null; headers?: Record<string, string> } = {},
) {
  const key = opts.key === undefined ? EXEC_KEY : opts.key;
  return fetch(`${baseURL}/api/v2/abilities/entitlements`, {
    method: "GET",
    headers: {
      ...(key ? { [COMPOSIO_EXEC_API_KEY_HEADER]: key } : {}),
      ...(opts.headers ?? {}),
    },
  });
}

// Exec through the same production router — the parity oracle for the
// ambiguity tests: what enumerate advertises must execute, what it withholds
// must deny.
function exec(body: unknown) {
  return fetch(`${baseURL}/api/v2/composio/exec`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      [COMPOSIO_EXEC_API_KEY_HEADER]: EXEC_KEY,
      ...workerHeaders(),
    },
    body: JSON.stringify(body),
  });
}

async function asJson<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

// Minimal Composio stub for the exec parity calls (subset of the
// composio-exec.test.ts stub): denial paths touch nothing, the one positive
// parity call touches execute + version pinning + connection resolution.
function installComposioStub(
  opts: { connections?: Array<{ id: string; userId: string }> } = {},
) {
  const stub = {
    tools: {
      execute: () => Promise.resolve({ data: { ok: true } }),
      getRawComposioTools: () => Promise.resolve([]),
    },
    toolkits: {
      get: () =>
        Promise.resolve({ meta: { availableVersions: ["20260429_00"] } }),
    },
    connectedAccounts: {
      list: (query: { userIds?: string[] }) => {
        const wanted = query.userIds ?? [];
        const items = (opts.connections ?? [])
          .filter((c) => wanted.includes(c.userId))
          .map((c) => ({ id: c.id, toolkit: { slug: "googlecalendar" } }));
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

// Grant seeding goes through the V1-adapter path (the same service functions
// the /v2/connections handlers call), which writes the legacy ConnectionGrant
// row AND the entitlement tables that enumerate reads — the same seeding rule
// composio-exec.test.ts follows.
async function seedGrant(data: {
  ownerAccountId: string;
  ownerInboxId: string;
  granteeInboxId?: string;
  conversationId?: string;
  toolkit?: string;
  actions?: string[];
  bundleIds?: string[];
  serviceVersion?: number;
  expiresAt?: Date;
}) {
  return issueConnectionGrant({
    accountId: data.ownerAccountId,
    ownerInboxId: data.ownerInboxId,
    granteeInboxId: data.granteeInboxId ?? AGENT_INBOX,
    conversationId: data.conversationId ?? CONVERSATION,
    toolkit: data.toolkit ?? "googlecalendar",
    actions: data.actions,
    bundleIds: data.bundleIds,
    serviceVersion: data.serviceVersion,
    expiresAt: data.expiresAt,
  });
}

beforeAll(async () => {
  await validateJWTKeys();
  __setComposioExecApiKeyOverrideForTests(EXEC_KEY);
  // Pin the read model onto the entitlement tables: the real gate reads the
  // shared database's migration ledgers, whose state this suite must not
  // depend on. The not-ready 503 has its own test below.
  __setEntitlementReadReadinessForTests(true);
  await new Promise<void>((resolve) => {
    server = app.listen(4016, () => {
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
  __setEntitlementReadReadinessForTests(null);
  __resetComposioServiceForTests(null);
});

// --- No DB required: auth mirrors exec exactly ---

describe("GET /v2/abilities/entitlements — auth + fail-closed (no DB)", () => {
  test("401 without an exec key", async () => {
    const res = await enumerate({ key: null, headers: workerHeaders() });
    expect(res.status).toBe(401);
  });

  test("401 with a wrong exec key", async () => {
    const res = await enumerate({
      key: "wrong".repeat(10),
      headers: workerHeaders(),
    });
    expect(res.status).toBe(401);
  });

  test("403 fail-closed when the worker identity headers are absent", async () => {
    const res = await enumerate();
    expect(res.status).toBe(403);
    expect((await asJson<{ code: string }>(res)).code).toBe(
      "trusted_identity_unavailable",
    );
  });

  test("403 fail-closed when only one identity header is present", async () => {
    const res = await enumerate({
      headers: workerHeaders({ conversationId: CONVERSATION }),
    });
    expect(res.status).toBe(403);
    expect((await asJson<{ code: string }>(res)).code).toBe(
      "trusted_identity_unavailable",
    );
  });
});

// --- No DB required: the production mount (order, shadowing, methods) ---

describe("GET /v2/abilities/entitlements — production mount (no DB)", () => {
  test("a client JWT cannot reach the worker route — the exec key is the only credential", async () => {
    const token = await createJwtToken({ deviceId: "device-enum" });
    const res = await fetch(`${baseURL}/api/v2/abilities/entitlements`, {
      headers: { "X-Convos-AuthToken": token, ...workerHeaders() },
    });
    expect(res.status).toBe(401);
  });

  test("the JWT-gated catalog still serves next to the worker route", async () => {
    const token = await createJwtToken({ deviceId: "device-enum" });
    const res = await fetch(`${baseURL}/api/v2/abilities`, {
      headers: { "X-Convos-AuthToken": token },
    });
    expect(res.status).toBe(200);
    const body = await asJson<{ catalogVersion: number }>(res);
    expect(typeof body.catalogVersion).toBe("number");
  });

  test("only GET is worker-authed: POST /v2/abilities/entitlements falls to the JWT subtree and rejects the exec key", async () => {
    const res = await fetch(`${baseURL}/api/v2/abilities/entitlements`, {
      method: "POST",
      headers: {
        [COMPOSIO_EXEC_API_KEY_HEADER]: EXEC_KEY,
        ...workerHeaders(),
      },
    });
    expect(res.status).toBe(401);
  });
});

// --- DB-backed: requires the test Postgres (pnpm test:local) ---

describe("GET /v2/abilities/entitlements — enumeration (DB)", () => {
  const accountIds: string[] = [];

  async function makeAccount(): Promise<string> {
    const account = await prisma.account.create({ data: {} });
    accountIds.push(account.id);
    return account.id;
  }

  afterEach(async () => {
    __setEntitlementReadReadinessForTests(true);
    __resetComposioServiceForTests(null);
    await prisma.connectionGrant.deleteMany({
      where: { ownerAccountId: { in: accountIds } },
    });
    // Cascades entitlements + extensions.
    await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
    accountIds.length = 0;
  });

  test("empty abilities array when nothing is entitled here — a valid response, never cached", async () => {
    const res = await enumerate({ headers: workerHeaders() });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await asJson<EnumerateResponse>(res)).toEqual({ abilities: [] });
  });

  test("single owner: bundle scope resolves to the exec action union, slugs on the wire", async () => {
    const ownerAccountId = await makeAccount();
    await seedGrant({
      ownerAccountId,
      ownerInboxId: "owner-inbox",
      bundleIds: ["calendar.events"],
      serviceVersion: 5,
    });

    const res = await enumerate({ headers: workerHeaders() });
    expect(res.status).toBe(200);
    expect(await asJson<EnumerateResponse>(res)).toEqual({
      abilities: [
        {
          abilityId: "googlecalendar",
          owners: [
            {
              ownerInboxId: "owner-inbox",
              // The same resolution exec enforces for calendar.events, sorted.
              actions: [
                "GOOGLECALENDAR_CREATE_EVENT",
                "GOOGLECALENDAR_DELETE_EVENT",
                "GOOGLECALENDAR_EVENTS_LIST",
                "GOOGLECALENDAR_PATCH_EVENT",
                "GOOGLECALENDAR_UPDATE_EVENT",
              ],
            },
          ],
        },
      ],
    });
  });

  test("legacy explicit actions union with the bundle-resolved set", async () => {
    const ownerAccountId = await makeAccount();
    await seedGrant({
      ownerAccountId,
      ownerInboxId: "owner-inbox",
      actions: ["GOOGLECALENDAR_FIND_FREE_SLOTS"],
      bundleIds: ["calendar.events.read"],
      serviceVersion: 2,
    });

    const res = await enumerate({ headers: workerHeaders() });
    expect(res.status).toBe(200);
    const body = await asJson<EnumerateResponse>(res);
    expect(body.abilities[0].owners[0].actions).toEqual([
      "GOOGLECALENDAR_EVENTS_LIST",
      "GOOGLECALENDAR_FIND_FREE_SLOTS",
    ]);
  });

  test("whole-toolkit transition default is served as an empty actions array", async () => {
    const ownerAccountId = await makeAccount();
    await seedGrant({
      ownerAccountId,
      ownerInboxId: "owner-inbox",
      actions: [],
    });

    const res = await enumerate({ headers: workerHeaders() });
    expect(res.status).toBe(200);
    const body = await asJson<EnumerateResponse>(res);
    expect(body.abilities).toEqual([
      {
        abilityId: "googlecalendar",
        owners: [{ ownerInboxId: "owner-inbox", actions: [] }],
      },
    ]);
  });

  test("multi-owner under distinct selectors: both advertised in full — onBehalfOf isolates each", async () => {
    const alice = await makeAccount();
    const bob = await makeAccount();
    await seedGrant({
      ownerAccountId: bob,
      ownerInboxId: "bob-inbox",
      bundleIds: ["calendar.events.read"],
      serviceVersion: 2,
    });
    await seedGrant({
      ownerAccountId: alice,
      ownerInboxId: "alice-inbox",
      bundleIds: ["calendar.events"],
      serviceVersion: 5,
    });

    const res = await enumerate({ headers: workerHeaders() });
    expect(res.status).toBe(200);
    const body = await asJson<EnumerateResponse>(res);
    expect(body.abilities).toHaveLength(1);
    expect(body.abilities[0].abilityId).toBe("googlecalendar");
    // Overlapping scopes (both grant EVENTS_LIST) are NOT ambiguous here:
    // each entry's selector isolates its owner for exec.
    expect(body.abilities[0].owners.map((owner) => owner.ownerInboxId)).toEqual(
      ["alice-inbox", "bob-inbox"],
    );
    // Each owner keeps their OWN scope — bob's read-only bundle never widens.
    expect(body.abilities[0].owners[1].actions).toEqual([
      "GOOGLECALENDAR_EVENTS_LIST",
    ]);
  });

  test("scoped to the trusted pair: other conversations and other agents are invisible", async () => {
    const ownerAccountId = await makeAccount();
    await seedGrant({
      ownerAccountId,
      ownerInboxId: "owner-inbox",
      conversationId: "conv-elsewhere",
      bundleIds: ["calendar.events"],
      serviceVersion: 5,
    });
    await seedGrant({
      ownerAccountId,
      ownerInboxId: "owner-inbox",
      granteeInboxId: "agent-other",
      bundleIds: ["calendar.events"],
      serviceVersion: 5,
    });

    const res = await enumerate({ headers: workerHeaders() });
    expect(res.status).toBe(200);
    expect(await asJson<EnumerateResponse>(res)).toEqual({ abilities: [] });
  });

  test("abilities are sorted by abilityId", async () => {
    const ownerAccountId = await makeAccount();
    await seedGrant({
      ownerAccountId,
      ownerInboxId: "owner-inbox",
      toolkit: "spotify",
      actions: [],
    });
    await seedGrant({
      ownerAccountId,
      ownerInboxId: "owner-inbox",
      bundleIds: ["calendar.events"],
      serviceVersion: 5,
    });

    const res = await enumerate({ headers: workerHeaders() });
    expect(res.status).toBe(200);
    const body = await asJson<EnumerateResponse>(res);
    expect(body.abilities.map((ability) => ability.abilityId)).toEqual([
      "googlecalendar",
      "spotify",
    ]);
  });

  test("revoked extensions are excluded", async () => {
    const ownerAccountId = await makeAccount();
    await seedGrant({
      ownerAccountId,
      ownerInboxId: "owner-inbox",
      bundleIds: ["calendar.events"],
      serviceVersion: 5,
    });
    await revokeConnectionGrantsByNaturalKey({
      accountId: ownerAccountId,
      toolkit: "googlecalendar",
      conversationId: CONVERSATION,
      granteeInboxId: AGENT_INBOX,
    });

    const res = await enumerate({ headers: workerHeaders() });
    expect(res.status).toBe(200);
    expect(await asJson<EnumerateResponse>(res)).toEqual({ abilities: [] });
  });

  test("expired extensions are excluded", async () => {
    const ownerAccountId = await makeAccount();
    await seedGrant({
      ownerAccountId,
      ownerInboxId: "owner-inbox",
      bundleIds: ["calendar.events"],
      serviceVersion: 5,
      expiresAt: new Date(Date.now() - 1_000),
    });

    const res = await enumerate({ headers: workerHeaders() });
    expect(res.status).toBe(200);
    expect(await asJson<EnumerateResponse>(res)).toEqual({ abilities: [] });
  });

  test("fail-closed: a scope of unresolvable bundleIds is never advertised (exec parity)", async () => {
    const ownerAccountId = await makeAccount();
    await seedGrant({
      ownerAccountId,
      ownerInboxId: "owner-inbox",
      bundleIds: ["calendar.bogus"],
      serviceVersion: 2,
    });

    const res = await enumerate({ headers: workerHeaders() });
    expect(res.status).toBe(200);
    expect(await asJson<EnumerateResponse>(res)).toEqual({ abilities: [] });
  });

  test("503 entitlements_unavailable while the read model is not ready — never partial", async () => {
    __setEntitlementReadReadinessForTests(false);
    const ownerAccountId = await makeAccount();
    await seedGrant({
      ownerAccountId,
      ownerInboxId: "owner-inbox",
      bundleIds: ["calendar.events"],
      serviceVersion: 5,
    });

    const res = await enumerate({ headers: workerHeaders() });
    expect(res.status).toBe(503);
    expect((await asJson<{ code: string }>(res)).code).toBe(
      "entitlements_unavailable",
    );
  });

  test("bearer capabilities never leak: no connection id, no account id anywhere in the response", async () => {
    const ownerAccountId = await makeAccount();
    const entitlement = await prisma.abilityEntitlement.create({
      data: {
        accountId: ownerAccountId,
        abilityId: "googlecalendar",
        status: "active",
        externalConnectionId: "ca_super_secret_bearer",
      },
    });
    await prisma.conversationAbility.create({
      data: {
        entitlementId: entitlement.id,
        conversationId: CONVERSATION,
        agentInboxId: AGENT_INBOX,
        bundleIds: ["calendar.events"],
        extendedByInboxId: "owner-inbox",
      },
    });

    const res = await enumerate({ headers: workerHeaders() });
    expect(res.status).toBe(200);
    const raw = await res.text();
    expect(raw).toContain("googlecalendar");
    expect(raw).not.toContain("ca_super_secret_bearer");
    expect(raw).not.toContain(ownerAccountId);
    expect(raw).not.toContain(entitlement.id);
  });

  // Ambiguity parity with exec: an advertised (owner, action) pair must be
  // executable; where exec answers ambiguous_grant, enumerate must not
  // advertise the action as cleanly available. Both paths run through the
  // production router so they cannot drift silently.

  test("duplicate selector: two accounts behind one inbox id — action withheld everywhere exec would be ambiguous", async () => {
    const alice = await makeAccount();
    const bob = await makeAccount();
    for (const ownerAccountId of [alice, bob]) {
      await seedGrant({
        ownerAccountId,
        ownerInboxId: "shared-inbox",
        actions: ["GOOGLECALENDAR_EVENTS_LIST"],
      });
    }
    installComposioStub();

    // Exec: the shared selector cannot isolate an owner.
    const withSelector = await exec({
      toolkit: "googlecalendar",
      action: "GOOGLECALENDAR_EVENTS_LIST",
      args: {},
      onBehalfOf: "shared-inbox",
    });
    expect(withSelector.status).toBe(409);
    expect((await asJson<{ code: string }>(withSelector)).code).toBe(
      "ambiguous_grant",
    );

    // Enumerate parity: the only action of both entries is ambiguous, so
    // neither entry — and hence the ability — is advertised at all.
    const res = await enumerate({ headers: workerHeaders() });
    expect(res.status).toBe(200);
    expect(await asJson<EnumerateResponse>(res)).toEqual({ abilities: [] });
  });

  test("null extender overlapping another owner: only the selectable owner is advertised", async () => {
    const alice = await makeAccount();
    const bob = await makeAccount();
    // Alice's extension never recorded an extender (a V2 write without it) —
    // no onBehalfOf value can name her.
    const aliceEntitlement = await prisma.abilityEntitlement.create({
      data: { accountId: alice, abilityId: "googlecalendar", status: "active" },
    });
    await prisma.conversationAbility.create({
      data: {
        entitlementId: aliceEntitlement.id,
        conversationId: CONVERSATION,
        agentInboxId: AGENT_INBOX,
        actions: ["GOOGLECALENDAR_EVENTS_LIST"],
        extendedByInboxId: null,
      },
    });
    await seedGrant({
      ownerAccountId: bob,
      ownerInboxId: "bob-inbox",
      actions: ["GOOGLECALENDAR_EVENTS_LIST", "GOOGLECALENDAR_CREATE_EVENT"],
    });
    installComposioStub({ connections: [{ id: "conn_bob", userId: bob }] });

    // Exec: without a selector the overlap is ambiguous (alice unreachable)…
    const noSelector = await exec({
      toolkit: "googlecalendar",
      action: "GOOGLECALENDAR_EVENTS_LIST",
      args: {},
    });
    expect(noSelector.status).toBe(409);
    expect((await asJson<{ code: string }>(noSelector)).code).toBe(
      "ambiguous_grant",
    );
    // …while the advertised call (bob via onBehalfOf) executes.
    const advertised = await exec({
      toolkit: "googlecalendar",
      action: "GOOGLECALENDAR_EVENTS_LIST",
      args: {},
      onBehalfOf: "bob-inbox",
    });
    expect(advertised.status).toBe(200);

    // Enumerate parity: alice's only action is exec-ambiguous on the only
    // call that could reach her, so her entry is withheld; bob keeps his
    // full scope.
    const res = await enumerate({ headers: workerHeaders() });
    expect(res.status).toBe(200);
    const body = await asJson<EnumerateResponse>(res);
    expect(body.abilities).toEqual([
      {
        abilityId: "googlecalendar",
        owners: [
          {
            ownerInboxId: "bob-inbox",
            actions: [
              "GOOGLECALENDAR_CREATE_EVENT",
              "GOOGLECALENDAR_EVENTS_LIST",
            ],
          },
        ],
      },
    ]);
  });

  test("a whole-toolkit owner with a distinct selector stays fully advertised next to another owner", async () => {
    const alice = await makeAccount();
    const bob = await makeAccount();
    // Alice: legacy whole-toolkit (empty scope = everything). Bob: one
    // action. Distinct selectors isolate both for exec, so both entries are
    // clean — alice's [] (everything) included.
    await seedGrant({
      ownerAccountId: alice,
      ownerInboxId: "alice-inbox",
      actions: [],
    });
    await seedGrant({
      ownerAccountId: bob,
      ownerInboxId: "bob-inbox",
      actions: ["GOOGLECALENDAR_EVENTS_LIST"],
    });
    installComposioStub({ connections: [{ id: "conn_alice", userId: alice }] });

    // Exec: the advertised whole-toolkit call (alice via onBehalfOf) executes
    // even the overlapping action…
    const advertised = await exec({
      toolkit: "googlecalendar",
      action: "GOOGLECALENDAR_EVENTS_LIST",
      args: {},
      onBehalfOf: "alice-inbox",
    });
    expect(advertised.status).toBe(200);
    // …only the selector-less call is ambiguous.
    const noSelector = await exec({
      toolkit: "googlecalendar",
      action: "GOOGLECALENDAR_EVENTS_LIST",
      args: {},
    });
    expect(noSelector.status).toBe(409);

    const res = await enumerate({ headers: workerHeaders() });
    expect(res.status).toBe(200);
    const body = await asJson<EnumerateResponse>(res);
    expect(body.abilities).toEqual([
      {
        abilityId: "googlecalendar",
        owners: [
          { ownerInboxId: "alice-inbox", actions: [] },
          {
            ownerInboxId: "bob-inbox",
            actions: ["GOOGLECALENDAR_EVENTS_LIST"],
          },
        ],
      },
    ]);
  });

  test("a null-extender whole-toolkit entry overlapped by another owner is withheld entirely (fail closed)", async () => {
    const alice = await makeAccount();
    const bob = await makeAccount();
    // Alice: whole-toolkit with no recorded extender — only the selector-less
    // exec call can reach her, and bob's overlap makes part of it ambiguous.
    const aliceEntitlement = await prisma.abilityEntitlement.create({
      data: { accountId: alice, abilityId: "googlecalendar", status: "active" },
    });
    await prisma.conversationAbility.create({
      data: {
        entitlementId: aliceEntitlement.id,
        conversationId: CONVERSATION,
        agentInboxId: AGENT_INBOX,
        actions: [],
        bundleIds: [],
        extendedByInboxId: null,
      },
    });
    await seedGrant({
      ownerAccountId: bob,
      ownerInboxId: "bob-inbox",
      actions: ["GOOGLECALENDAR_EVENTS_LIST"],
    });
    installComposioStub({ connections: [{ id: "conn_alice", userId: alice }] });

    // Exec: the overlapping action is ambiguous without a selector…
    const overlapped = await exec({
      toolkit: "googlecalendar",
      action: "GOOGLECALENDAR_EVENTS_LIST",
      args: {},
    });
    expect(overlapped.status).toBe(409);
    // …while the non-overlapping remainder still executes (alice resolves
    // uniquely) — exec stays the authority for what enumerate
    // under-advertises below.
    const remainder = await exec({
      toolkit: "googlecalendar",
      action: "GOOGLECALENDAR_CREATE_EVENT",
      args: {},
    });
    expect(remainder.status).toBe(200);

    // Enumerate: "everything except bob's overlap" is not expressible as an
    // action list, so alice's whole-toolkit entry is withheld entirely
    // rather than advertised as cleanly-everything; bob stays.
    const res = await enumerate({ headers: workerHeaders() });
    expect(res.status).toBe(200);
    const body = await asJson<EnumerateResponse>(res);
    expect(body.abilities).toEqual([
      {
        abilityId: "googlecalendar",
        owners: [
          {
            ownerInboxId: "bob-inbox",
            actions: ["GOOGLECALENDAR_EVENTS_LIST"],
          },
        ],
      },
    ]);
  });

  test("live response matches the published schema shape (runtime key-set pin)", async () => {
    // No JSON Schema validator is a direct dependency (ajv is
    // transitive-only) and this endpoint adds no deps, so instead of full
    // draft-2020-12 validation the schema file's own declared contract —
    // required + additionalProperties:false at every level, i.e. the exact
    // key set — is pinned against a live response. Drift in either the
    // schema or the serializer fails this test.
    const schema = JSON.parse(
      readFileSync(
        new URL(
          "../docs/schemas/abilities-entitlements-worker.schema.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as {
      required: string[];
      additionalProperties: boolean;
      $defs: Record<
        string,
        { required: string[]; additionalProperties: boolean }
      >;
    };

    const ownerAccountId = await makeAccount();
    await seedGrant({
      ownerAccountId,
      ownerInboxId: "owner-inbox",
      bundleIds: ["calendar.events"],
      serviceVersion: 5,
    });

    const res = await enumerate({ headers: workerHeaders() });
    expect(res.status).toBe(200);
    const body = await asJson<Record<string, unknown>>(res);

    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(body).sort()).toEqual([...schema.required].sort());

    const abilitySchema = schema.$defs.Ability;
    const ownerSchema = schema.$defs.Owner;
    expect(abilitySchema.additionalProperties).toBe(false);
    expect(ownerSchema.additionalProperties).toBe(false);

    const abilities = body.abilities as Array<Record<string, unknown>>;
    expect(abilities.length).toBeGreaterThan(0);
    for (const ability of abilities) {
      expect(Object.keys(ability).sort()).toEqual(
        [...abilitySchema.required].sort(),
      );
      expect(typeof ability.abilityId).toBe("string");
      const owners = ability.owners as Array<Record<string, unknown>>;
      expect(owners.length).toBeGreaterThan(0);
      for (const owner of owners) {
        expect(Object.keys(owner).sort()).toEqual(
          [...ownerSchema.required].sort(),
        );
        const inbox = owner.ownerInboxId;
        expect(inbox === null || typeof inbox === "string").toBe(true);
        const actions = owner.actions as unknown[];
        expect(Array.isArray(actions)).toBe(true);
        for (const action of actions) {
          expect(typeof action).toBe("string");
        }
      }
    }
  });
});
