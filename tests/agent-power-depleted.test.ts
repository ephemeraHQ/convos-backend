import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import express, {
  type Response as ExpressResponse,
  type NextFunction,
  type Request,
} from "express";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import { __setAssistantConfigOverridesForTests } from "@/api/v2/agents/handlers/assistant-config";
import { joinHandler } from "@/api/v2/agents/handlers/join";
import { joinStatusHandler } from "@/api/v2/agents/handlers/join-status";
import { recordAgentInstanceDispatched } from "@/api/v2/agents/lib/agent-instances";
import { getParticipationHandler } from "@/api/v2/conversations/handlers/participation";
import { jsonMiddleware } from "@/middleware/json";
import { pinoMiddleware } from "@/middleware/pino";
import { getBalance, getBalances } from "@/payments";
import type * as PaymentsModule from "@/payments";
import { prisma } from "@/utils/prisma";
import { seedAccount, seedBalance } from "./credits/helpers";

// Wrap the two balance reads with counting passthroughs so the batch test can
// assert "one getBalances call, zero per-agent getBalance calls" — spying on
// prisma delegates directly is not an option (they are Proxy-backed and break
// under vi.spyOn). Everything else in @/payments passes through untouched.
vi.mock("@/payments", async (importOriginal) => {
  const actual = await importOriginal<typeof PaymentsModule>();
  return {
    ...actual,
    getBalance: vi.fn(actual.getBalance),
    getBalances: vi.fn(actual.getBalances),
  };
});

// The owner-computed `agentPowerDepleted` field (CON-807).
//
// Semantics under test: agentPowerDepleted === true ⇔ the agent's PAYER (the
// account that added the agent) cannot fund a turn right now — the exact
// negation of the runtime spend gate (balance >= reservedMaxTurnCredits;
// tests pin PAYMENTS_RESERVED_MAX_TURN_CREDITS=1 in tests/setup.ts). The
// field is viewer-independent: the VIEWER's own wallet must never leak into
// it. That leak is the CON-807 bug this field exists to retire.

let mockFetchImpl: (url: string, init?: RequestInit) => Promise<Response>;
const originalFetch = globalThis.fetch;

const ASSISTANT_URL = "https://assistants.test.local";
const ASSISTANT_KEY = "test-assistant-key";
const TEST_ACCOUNT_HEADER = "x-test-account-id";
const DEFAULT_TEST_ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";

// Mirrors production mounting: authMiddleware+requireAccount populate
// res.locals.accountId; here a header stands in so tests can act as
// different VIEWERS (the point of the viewer-independence assertions).
function testAccountMiddleware(
  req: Request,
  res: ExpressResponse,
  next: NextFunction,
) {
  res.locals.accountId =
    req.header(TEST_ACCOUNT_HEADER) ?? DEFAULT_TEST_ACCOUNT_ID;
  next();
}

const app = express();
app.use(pinoMiddleware);
app.use(jsonMiddleware);
app.use(testAccountMiddleware);
app.post("/api/v2/agents/join", joinHandler);
app.get("/api/v2/agents/join/:instanceId", joinStatusHandler);
app.get(
  "/api/v2/conversations/:conversationId/participation",
  getParticipationHandler,
);

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Upstream control plane answering the participation read with a mode. */
function mockParticipationUpstream(mode: string = "speak") {
  mockFetchImpl = (url) => {
    expect(url).toContain("/participation");
    return Promise.resolve(jsonResponse(200, { mode }));
  };
}

type ParticipationBody = {
  success: boolean;
  conversationId: string;
  mode: string;
  agents?: Array<{ inboxId: string; agentPowerDepleted: boolean }>;
};

describe("agentPowerDepleted (owner-computed agent power)", () => {
  let server: Server;
  let baseURL: string;

  const createdAccountIds: string[] = [];
  const createdInstanceIds: string[] = [];

  const newAccount = async (): Promise<string> => {
    const id = await seedAccount();
    createdAccountIds.push(id);
    return id;
  };

  const seedAgent = async (args: {
    ownerAccountId: string;
    conversationId: string | null;
    inboxId: string | null;
  }): Promise<string> => {
    const instanceId = `pwr-${randomUUID()}`;
    createdInstanceIds.push(instanceId);
    await prisma.agentInstance.create({
      data: { instanceId, ...args },
    });
    return instanceId;
  };

  beforeAll(async () => {
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const addr = server.address();
        if (!addr || typeof addr === "string") {
          throw new Error("Failed to resolve test server address");
        }
        baseURL = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    globalThis.fetch = originalFetch;
    __setAssistantConfigOverridesForTests({});
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  });

  beforeEach(() => {
    __setAssistantConfigOverridesForTests({
      assistantApiUrl: ASSISTANT_URL,
      assistantApiKey: ASSISTANT_KEY,
      joinWaitBudgetMs: 200,
      joinPollIntervalMs: 20,
    });
    mockFetchImpl = () => Promise.reject(new Error("unmocked fetch"));
    globalThis.fetch = ((url: string, init?: RequestInit) =>
      mockFetchImpl(url, init)) as typeof fetch;
  });

  afterEach(async () => {
    // Clear call history only — the @/payments wrappers keep their real
    // passthrough implementations across tests.
    vi.clearAllMocks();
    __setAssistantConfigOverridesForTests({});
    await prisma.agentInstance.deleteMany({
      where: { instanceId: { in: createdInstanceIds.splice(0) } },
    });
    const accountIds = createdAccountIds.splice(0);
    await prisma.creditLedger.deleteMany({
      where: { accountId: { in: accountIds } },
    });
    await prisma.userCredits.deleteMany({
      where: { accountId: { in: accountIds } },
    });
    await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
  });

  const getParticipation = (conversationId: string, viewerAccountId: string) =>
    originalFetch(
      `${baseURL}/api/v2/conversations/${conversationId}/participation`,
      { headers: { [TEST_ACCOUNT_HEADER]: viewerAccountId } },
    );

  const getJoinStatus = (instanceId: string, viewerAccountId: string) =>
    originalFetch(
      `${baseURL}/api/v2/agents/join/${encodeURIComponent(instanceId)}`,
      { headers: { [TEST_ACCOUNT_HEADER]: viewerAccountId } },
    );

  describe("GET /conversations/:conversationId/participation", () => {
    test("depleted OWNER → agentPowerDepleted: true for EVERY viewer (funded or broke)", async () => {
      const owner = await newAccount(); // balance 0 < reserved 1 → depleted
      const fundedViewer = await newAccount();
      await seedBalance(fundedViewer, 1_000n);
      const brokeViewer = await newAccount(); // balance 0

      const conversationId = `c${randomUUID().replaceAll("-", "")}`;
      await seedAgent({
        ownerAccountId: owner,
        conversationId,
        inboxId: "inbox-depleted-owner",
      });

      mockParticipationUpstream();

      for (const viewer of [fundedViewer, brokeViewer]) {
        const res = await getParticipation(conversationId, viewer);
        expect(res.status).toBe(200);
        const body = (await res.json()) as ParticipationBody;
        expect(body.mode).toBe("speak");
        expect(body.agents).toEqual([
          { inboxId: "inbox-depleted-owner", agentPowerDepleted: true },
        ]);
      }
    });

    test("CON-807 regression: a ZERO-balance viewer sees a funded owner's agent as powered (agentPowerDepleted: false)", async () => {
      // The original bug: iOS bound "lost power" to the VIEWER's wallet, so a
      // broke viewer saw every agent as dead — including other people's
      // funded agents. The backend field must be computed from the OWNER's
      // wallet only, so this exact scenario must read false.
      const owner = await newAccount();
      await seedBalance(owner, 5n); // >= reserved (1) → owner can fund a turn
      const brokeViewer = await newAccount(); // the CON-807 viewer: balance 0

      const conversationId = `c${randomUUID().replaceAll("-", "")}`;
      await seedAgent({
        ownerAccountId: owner,
        conversationId,
        inboxId: "inbox-funded-owner",
      });

      mockParticipationUpstream();

      const res = await getParticipation(conversationId, brokeViewer);
      expect(res.status).toBe(200);
      const body = (await res.json()) as ParticipationBody;
      expect(body.agents).toEqual([
        { inboxId: "inbox-funded-owner", agentPowerDepleted: false },
      ]);
    });

    test("viewer-independence: byte-identical agents array for owner, funded viewer, and broke viewer", async () => {
      const ownerFunded = await newAccount();
      await seedBalance(ownerFunded, 100n);
      const ownerBroke = await newAccount();
      const fundedViewer = await newAccount();
      await seedBalance(fundedViewer, 100n);
      const brokeViewer = await newAccount();

      const conversationId = `c${randomUUID().replaceAll("-", "")}`;
      await seedAgent({
        ownerAccountId: ownerFunded,
        conversationId,
        inboxId: "inbox-a",
      });
      await seedAgent({
        ownerAccountId: ownerBroke,
        conversationId,
        inboxId: "inbox-b",
      });

      mockParticipationUpstream();

      const bodies: ParticipationBody[] = [];
      for (const viewer of [
        ownerFunded,
        ownerBroke,
        fundedViewer,
        brokeViewer,
      ]) {
        const res = await getParticipation(conversationId, viewer);
        expect(res.status).toBe(200);
        bodies.push((await res.json()) as ParticipationBody);
      }
      const [first, ...rest] = bodies;
      for (const body of rest) {
        expect(body.agents).toEqual(first.agents);
      }
      expect(first.agents).toEqual([
        { inboxId: "inbox-a", agentPowerDepleted: false },
        { inboxId: "inbox-b", agentPowerDepleted: true },
      ]);
    });

    test("list is batched: one AgentInstance read + one balance read for N agents / M owners; unregistered agents excluded", async () => {
      const owner1 = await newAccount();
      await seedBalance(owner1, 50n);
      const owner2 = await newAccount(); // depleted
      const viewer = await newAccount();

      const conversationId = `c${randomUUID().replaceAll("-", "")}`;
      await seedAgent({
        ownerAccountId: owner1,
        conversationId,
        inboxId: "inbox-1",
      });
      await seedAgent({
        ownerAccountId: owner1,
        conversationId,
        inboxId: "inbox-2",
      });
      await seedAgent({
        ownerAccountId: owner2,
        conversationId,
        inboxId: "inbox-3",
      });
      // Registration still in flight — no inboxId, must be excluded.
      await seedAgent({
        ownerAccountId: owner2,
        conversationId,
        inboxId: null,
      });

      mockParticipationUpstream();

      vi.mocked(getBalances).mockClear();
      vi.mocked(getBalance).mockClear();

      const res = await getParticipation(conversationId, viewer);
      expect(res.status).toBe(200);
      const body = (await res.json()) as ParticipationBody;

      expect(body.agents).toEqual([
        { inboxId: "inbox-1", agentPowerDepleted: false },
        { inboxId: "inbox-2", agentPowerDepleted: false },
        { inboxId: "inbox-3", agentPowerDepleted: true },
      ]);

      // Batch contract: 3 rendered agents (4 rows) across 2 owners cost
      // exactly ONE batched balance read over the DISTINCT owners — and
      // zero per-agent getBalance calls.
      expect(getBalances).toHaveBeenCalledTimes(1);
      expect(vi.mocked(getBalances).mock.calls[0][0]).toEqual(
        expect.arrayContaining([owner1, owner2]),
      );
      expect(vi.mocked(getBalances).mock.calls[0][0]).toHaveLength(2);
      expect(getBalance).not.toHaveBeenCalled();
    });

    test("no recorded agents → agents: [] (still viewer-independent, still 200)", async () => {
      const viewer = await newAccount();
      const conversationId = `c${randomUUID().replaceAll("-", "")}`;
      mockParticipationUpstream("paused");

      const res = await getParticipation(conversationId, viewer);
      expect(res.status).toBe(200);
      const body = (await res.json()) as ParticipationBody;
      expect(body.mode).toBe("paused");
      expect(body.agents).toEqual([]);
    });

    test("enrichment failure degrades to the legacy shape: 200 with mode, agents omitted", async () => {
      const owner = await newAccount();
      const viewer = await newAccount();
      const conversationId = `c${randomUUID().replaceAll("-", "")}`;
      // An agent must exist so the enrichment reaches the balance read that
      // is made to fail.
      await seedAgent({
        ownerAccountId: owner,
        conversationId,
        inboxId: "inbox-degrade",
      });
      mockParticipationUpstream();

      vi.mocked(getBalances).mockRejectedValueOnce(new Error("db down"));

      const res = await getParticipation(conversationId, viewer);
      expect(res.status).toBe(200);
      const body = (await res.json()) as ParticipationBody;
      expect(body.success).toBe(true);
      expect(body.mode).toBe("speak");
      expect(body).not.toHaveProperty("agents");
    });
  });

  describe("join bookkeeping (the agent → owner mapping)", () => {
    test("direct-add join records owner + conversation at dispatch and inboxId at registration", async () => {
      const owner = await newAccount();
      const conversationId = "abc123def4567890";
      const instanceId = `pwr-${randomUUID()}`;
      createdInstanceIds.push(instanceId);

      mockFetchImpl = (url, init) => {
        if (init?.method === "POST") {
          return Promise.resolve(jsonResponse(200, { instanceId }));
        }
        return Promise.resolve(
          jsonResponse(200, {
            instanceId,
            joinStatus: "pending_acceptance",
            inboxId: "inbox-direct-add",
            conversationId,
          }),
        );
      };

      const res = await originalFetch(`${baseURL}/api/v2/agents/join`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [TEST_ACCOUNT_HEADER]: owner,
        },
        body: JSON.stringify({ conversationId }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { inboxId: string | null };
      expect(body.inboxId).toBe("inbox-direct-add");

      const row = await prisma.agentInstance.findUnique({
        where: { instanceId },
      });
      expect(row).not.toBeNull();
      expect(row?.ownerAccountId).toBe(owner);
      expect(row?.conversationId).toBe(conversationId);
      expect(row?.inboxId).toBe("inbox-direct-add");
    });

    test("invite (slug) join learns conversationId + inboxId from the joined status row", async () => {
      const owner = await newAccount();
      const instanceId = `pwr-${randomUUID()}`;
      createdInstanceIds.push(instanceId);

      mockFetchImpl = (url, init) => {
        if (init?.method === "POST") {
          return Promise.resolve(jsonResponse(200, { instanceId }));
        }
        return Promise.resolve(
          jsonResponse(200, {
            instanceId,
            joinStatus: "joined",
            inboxId: "inbox-invite",
            conversationId: "fedcba9876543210",
          }),
        );
      };

      const res = await originalFetch(`${baseURL}/api/v2/agents/join`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [TEST_ACCOUNT_HEADER]: owner,
        },
        body: JSON.stringify({ slug: "some-invite-slug" }),
      });
      expect(res.status).toBe(200);

      const row = await prisma.agentInstance.findUnique({
        where: { instanceId },
      });
      expect(row?.ownerAccountId).toBe(owner);
      expect(row?.conversationId).toBe("fedcba9876543210");
      expect(row?.inboxId).toBe("inbox-invite");
    });

    test("ownership is first-writer-wins: a re-dispatch for the same instance cannot reassign who pays", async () => {
      const owner = await newAccount();
      const other = await newAccount();
      const instanceId = `pwr-${randomUUID()}`;
      createdInstanceIds.push(instanceId);

      await recordAgentInstanceDispatched({
        instanceId,
        ownerAccountId: owner,
        conversationId: null,
      });
      await recordAgentInstanceDispatched({
        instanceId,
        ownerAccountId: other,
        conversationId: "abc123def4567890",
      });

      const row = await prisma.agentInstance.findUnique({
        where: { instanceId },
      });
      expect(row?.ownerAccountId).toBe(owner);
      expect(row?.conversationId).toBe("abc123def4567890");
    });
  });

  describe("GET /agents/join/:instanceId", () => {
    test("carries owner-computed agentPowerDepleted and heals inboxId/conversationId, for any viewer", async () => {
      const owner = await newAccount();
      await seedBalance(owner, 10n);
      const brokeViewer = await newAccount(); // not the owner, zero balance

      const instanceId = await seedAgent({
        ownerAccountId: owner,
        conversationId: null,
        inboxId: null,
      });

      mockFetchImpl = () =>
        Promise.resolve(
          jsonResponse(200, {
            instanceId,
            joinStatus: "ready",
            inboxId: "inbox-heal",
            conversationId: "abc123def4567890",
          }),
        );

      const res = await getJoinStatus(instanceId, brokeViewer);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        joined: boolean;
        agentPowerDepleted?: boolean;
      };
      expect(body.joined).toBe(true);
      // Owner is funded → false, even though the CALLER is broke.
      expect(body.agentPowerDepleted).toBe(false);

      const row = await prisma.agentInstance.findUnique({
        where: { instanceId },
      });
      expect(row?.inboxId).toBe("inbox-heal");
      expect(row?.conversationId).toBe("abc123def4567890");
    });

    test("unknown instance (pre-bookkeeping dispatch) → field omitted, legacy shape intact", async () => {
      const viewer = await newAccount();
      const instanceId = `pwr-${randomUUID()}`; // deliberately never recorded

      mockFetchImpl = () =>
        Promise.resolve(
          jsonResponse(200, {
            instanceId,
            joinStatus: "joined",
            inboxId: "inbox-unknown",
            conversationId: null,
          }),
        );

      const res = await getJoinStatus(instanceId, viewer);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.success).toBe(true);
      expect(body.joined).toBe(true);
      expect(body).not.toHaveProperty("agentPowerDepleted");
    });
  });
});
