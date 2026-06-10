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
  __setTrustedCallerResolverForTests,
  type TrustedCaller,
} from "@/api/v2/composio/trusted-identity";
import {
  __resetComposioServiceForTests,
  ComposioService,
} from "@/api/v2/connections/composio.service";
import {
  __setAgentAssetsApiKeyOverrideForTests,
  AGENT_API_KEY_HEADER,
  agentApiKeyAuth,
} from "@/middleware/agentAuth";
import { jsonMiddleware } from "@/middleware/json";
import { pinoMiddleware } from "@/middleware/pino";
import { prisma } from "@/utils/prisma";

vi.mock("firebase-admin/app");
vi.mock("firebase-admin/app-check");
vi.mock("firebase-admin/messaging");

const AGENT_KEY = "x".repeat(40);
const AGENT_INBOX = "agent-inbox-1";
const CONVERSATION = "conv-1";

const app = express();
app.use(pinoMiddleware);
app.use(jsonMiddleware);
app.use("/api/v2/composio", agentApiKeyAuth, composioRouter);

let server: Server;
const baseURL = "http://localhost:4014";

// Minimal Composio stub: exec touches tools.execute and (when a grant pins no
// connection) connectedAccounts.list.
function installComposioStub(
  opts: {
    execute?: (
      slug: string,
      body: { userId: string; connectedAccountId?: string },
    ) => Promise<unknown>;
    connections?: Array<{ id: string; userId: string; slug: string }>;
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

function trust(caller: TrustedCaller | null) {
  __setTrustedCallerResolverForTests(
    caller ? () => Promise.resolve(caller) : null,
  );
}

function exec(body: unknown, key: string | null = AGENT_KEY) {
  return fetch(`${baseURL}/api/v2/composio/exec`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(key ? { [AGENT_API_KEY_HEADER]: key } : {}),
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
  __setAgentAssetsApiKeyOverrideForTests(AGENT_KEY);
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
  __setAgentAssetsApiKeyOverrideForTests(undefined);
  __resetComposioServiceForTests(null);
  __setTrustedCallerResolverForTests(null);
});

afterEach(() => {
  __setTrustedCallerResolverForTests(null);
  __resetComposioServiceForTests(null);
});

// --- No DB required: auth, validation, and the fail-closed security boundary ---

describe("POST /v2/composio/exec — auth + fail-closed (no DB)", () => {
  test("401 without an agent API key", async () => {
    const res = await exec(VALID_BODY, null);
    expect(res.status).toBe(401);
  });

  test("401 with a wrong agent API key", async () => {
    const res = await exec(VALID_BODY, "wrong".repeat(10));
    expect(res.status).toBe(401);
  });

  test("400 on an invalid body (missing action)", async () => {
    const res = await exec({ toolkit: "googlecalendar" });
    expect(res.status).toBe(400);
    expect((await asJson<{ code: string }>(res)).code).toBe("invalid_request");
  });

  test("403 fail-closed when no trusted identity is available", async () => {
    // Default resolver returns null — the agent cannot be authorized.
    const res = await exec(VALID_BODY);
    expect(res.status).toBe(403);
    expect((await asJson<{ code: string }>(res)).code).toBe(
      "trusted_identity_unavailable",
    );
  });

  test("agent-named fields cannot substitute for a trusted identity", async () => {
    // Even if the agent stuffs identity-looking fields into the body, exec
    // still fail-closes: resolution ignores the body entirely.
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

  test("executes when a live grant matches the trusted caller", async () => {
    const ownerAccountId = await makeAccount();
    await prisma.connectionGrant.create({
      data: {
        ownerAccountId,
        ownerInboxId: "owner-inbox",
        granteeInboxId: AGENT_INBOX,
        conversationId: CONVERSATION,
        toolkit: "googlecalendar",
        actions: [],
        connectionId: "conn_pinned",
      },
    });
    let seen: { userId: string; connectedAccountId?: string } | null = null;
    installComposioStub({
      execute: (_slug, body) => {
        seen = body;
        return Promise.resolve({ data: { events: [] } });
      },
    });
    trust({ conversationId: CONVERSATION, agentInboxId: AGENT_INBOX });

    const res = await exec(VALID_BODY);
    expect(res.status).toBe(200);
    expect((await asJson<{ data: unknown }>(res)).data).toEqual({ events: [] });
    // Composio is called with the OWNER's accountId, resolved server-side.
    expect(seen).toMatchObject({
      userId: ownerAccountId,
      connectedAccountId: "conn_pinned",
    });
  });

  test("403 no_grant when the agent holds no grant here", async () => {
    installComposioStub();
    trust({ conversationId: CONVERSATION, agentInboxId: AGENT_INBOX });
    const res = await exec(VALID_BODY);
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
        connectionId: "conn_pinned",
      },
    });
    installComposioStub();
    trust({ conversationId: CONVERSATION, agentInboxId: AGENT_INBOX });
    const res = await exec({
      ...VALID_BODY,
      action: "GOOGLECALENDAR_EVENTS_DELETE",
    });
    expect(res.status).toBe(403);
    expect((await asJson<{ code: string }>(res)).code).toBe("no_grant");
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
        connectionId: "conn_pinned",
        revokedAt: new Date(),
      },
    });
    installComposioStub();
    trust({ conversationId: CONVERSATION, agentInboxId: AGENT_INBOX });
    const res = await exec(VALID_BODY);
    expect(res.status).toBe(403);
    expect((await asJson<{ code: string }>(res)).code).toBe("no_grant");
  });

  test("409 ambiguous_grant when two owners shared the toolkit in one conversation", async () => {
    const ownerA = await makeAccount();
    const ownerB = await makeAccount();
    for (const ownerAccountId of [ownerA, ownerB]) {
      await prisma.connectionGrant.create({
        data: {
          ownerAccountId,
          ownerInboxId: `inbox-${ownerAccountId}`,
          granteeInboxId: AGENT_INBOX,
          conversationId: CONVERSATION,
          toolkit: "googlecalendar",
          actions: [],
          connectionId: `conn_${ownerAccountId}`,
        },
      });
    }
    installComposioStub();
    trust({ conversationId: CONVERSATION, agentInboxId: AGENT_INBOX });
    const res = await exec(VALID_BODY);
    expect(res.status).toBe(409);
    expect((await asJson<{ code: string }>(res)).code).toBe("ambiguous_grant");
  });

  test("resolves the connection from (owner, toolkit) when the grant pins none", async () => {
    const ownerAccountId = await makeAccount();
    await prisma.connectionGrant.create({
      data: {
        ownerAccountId,
        ownerInboxId: "owner-inbox",
        granteeInboxId: AGENT_INBOX,
        conversationId: CONVERSATION,
        toolkit: "googlecalendar",
        actions: [],
        connectionId: null,
      },
    });
    let seen: { connectedAccountId?: string } | null = null;
    installComposioStub({
      execute: (_slug, body) => {
        seen = body;
        return Promise.resolve({ data: {} });
      },
      connections: [
        { id: "conn_resolved", userId: ownerAccountId, slug: "googlecalendar" },
      ],
    });
    trust({ conversationId: CONVERSATION, agentInboxId: AGENT_INBOX });
    const res = await exec(VALID_BODY);
    expect(res.status).toBe(200);
    expect(seen).toMatchObject({ connectedAccountId: "conn_resolved" });
  });
});
