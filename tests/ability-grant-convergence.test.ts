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
import { checkEntitlement } from "@/api/v2/abilities/check-entitlement";
import { __setEntitlementReadReadinessForTests } from "@/api/v2/abilities/read-readiness";
import { connectionsRouter } from "@/api/v2/connections/connections.router";
import { authMiddleware, requireAccount } from "@/middleware/auth";
import { jsonMiddleware } from "@/middleware/json";
import { pinoMiddleware } from "@/middleware/pino";
import { createJwtToken } from "@/utils/jwt";
import logger from "@/utils/logger";
import { prisma } from "@/utils/prisma";

vi.mock("firebase-admin/app");
vi.mock("firebase-admin/app-check");
vi.mock("firebase-admin/messaging");

// The V1 grant convergence contract, pinned end to end.
//
// iOS persists a capability approval with POST /v2/connections/grants; exec
// authorizes with checkEntitlement's conversation path. Between the two sits
// the dual-store migration: the legacy ConnectionGrant row and the
// AbilityEntitlement + ConversationAbility pair, written together in one
// transaction (v1-grant-adapter.ts), read on either side of the read-model
// cutover (read-readiness.ts).
//
// This suite asserts the contract the hard way — exact rows in all three
// tables after the real HTTP write, then the authorization decision with the
// readiness gate forced BOTH ways on that same posted grant. A single live
// exec passing cannot catch a write that landed in only one store: whichever
// store the replica happens to read may be the one that got the row. Only
// row-level assertions on both stores do.
//
// Adjacent coverage, deliberately not repeated here: V1 endpoint semantics
// (upsert, revoke, listing) in connection-grants.test.ts; exec's HTTP surface
// and denial vocabulary in composio-exec.test.ts; adapter edge cases
// (case-variant reconciliation, V2 PUT mirroring) in both.

const app = express();
app.use(pinoMiddleware);
app.use(jsonMiddleware);
app.use(
  "/api/v2/connections",
  authMiddleware,
  requireAccount,
  connectionsRouter,
);

let server: Server;
const baseURL = "http://localhost:4017";

const OWNER_INBOX = "owner-inbox-convergence";
const AGENT_INBOX = "agent-inbox-convergence";
const CONVERSATION = "conv-convergence";

// The shape a shipped iOS build sends on approval. Mixed-case toolkit on
// purpose: the legacy row must keep the client's casing while the
// entitlement row stores the canonical id — both are asserted below.
const GRANT_BODY = {
  ownerInboxId: OWNER_INBOX,
  granteeInboxId: AGENT_INBOX,
  conversationId: CONVERSATION,
  toolkit: "GoogleCalendar",
  actions: ["GOOGLECALENDAR_EVENTS_LIST"],
  bundleIds: ["calendar.events"],
  serviceVersion: 2,
};

const accountIds: string[] = [];

async function makeAccount(): Promise<string> {
  const account = await prisma.account.create({ data: {} });
  accountIds.push(account.id);
  return account.id;
}

async function token(accountId: string): Promise<string> {
  return createJwtToken({ deviceId: "device-convergence", accountId });
}

async function postGrant(accountId: string, body: unknown) {
  return fetch(`${baseURL}/api/v2/connections/grants`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Convos-AuthToken": await token(accountId),
    },
    body: JSON.stringify(body),
  });
}

/** Exec's authorization question for the granted conversation, verbatim. */
function checkConversation() {
  return checkEntitlement({
    caller: {
      kind: "conversation",
      conversationId: CONVERSATION,
      agentInboxId: AGENT_INBOX,
    },
    abilityId: "googlecalendar",
    action: "GOOGLECALENDAR_EVENTS_LIST",
    catalog: null,
    log: logger,
  });
}

/** Run `fn` with the readiness gate pinned, always restoring afterwards. */
async function withReadiness<T>(
  ready: boolean,
  fn: () => Promise<T>,
): Promise<T> {
  __setEntitlementReadReadinessForTests(ready);
  try {
    return await fn();
  } finally {
    __setEntitlementReadReadinessForTests(null);
  }
}

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server = app.listen(4017, () => {
      resolve();
    });
  });
});

afterAll(async () => {
  __setEntitlementReadReadinessForTests(null);
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
});

afterEach(async () => {
  // Account delete cascades grants, entitlements, and extensions.
  await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
  accountIds.length = 0;
});

describe("V1 grant convergence — rows", () => {
  test("one POST writes the exact rows in all three tables (one transaction)", async () => {
    const accountId = await makeAccount();
    const res = await postGrant(accountId, GRANT_BODY);
    expect(res.status).toBe(200);
    const { id } = (await res.json()) as { id: string };

    // The legacy store: exactly one row, every field as the V1 contract
    // stores it — toolkit in the client's casing, no connectionId (never
    // accepted from the body), live (revokedAt null).
    const grants = await prisma.connectionGrant.findMany({
      where: { ownerAccountId: accountId },
    });
    expect(grants).toHaveLength(1);
    const grant = grants[0];
    expect(grant).toMatchObject({
      id,
      ownerAccountId: accountId,
      ownerInboxId: OWNER_INBOX,
      granteeInboxId: AGENT_INBOX,
      conversationId: CONVERSATION,
      toolkit: "GoogleCalendar",
      actions: ["GOOGLECALENDAR_EVENTS_LIST"],
      bundleIds: ["calendar.events"],
      serviceVersion: 2,
      connectionId: null,
      expiresAt: null,
      revokedAt: null,
    });

    // The entitlement store: exactly one entitlement, canonical lowercase
    // ability id, active, no tombstone.
    const entitlements = await prisma.abilityEntitlement.findMany({
      where: { accountId },
    });
    expect(entitlements).toHaveLength(1);
    const entitlement = entitlements[0];
    expect(entitlement).toMatchObject({
      accountId,
      abilityId: "googlecalendar",
      status: "active",
      revokedAt: null,
    });

    // The extension: exactly one row, sharing the legacy grant's id (V1
    // DELETE-by-id must address it), scope carried 1:1, the extender
    // recorded as the V1 owner inbox, createdAt aligned with the grant.
    const extensions = await prisma.conversationAbility.findMany({
      where: { entitlementId: entitlement.id },
    });
    expect(extensions).toHaveLength(1);
    expect(extensions[0]).toMatchObject({
      id: grant.id,
      entitlementId: entitlement.id,
      conversationId: CONVERSATION,
      agentInboxId: AGENT_INBOX,
      actions: ["GOOGLECALENDAR_EVENTS_LIST"],
      bundleIds: ["calendar.events"],
      extendedByInboxId: OWNER_INBOX,
      expiresAt: null,
    });
    expect(extensions[0].createdAt).toEqual(grant.createdAt);
  });

  test("re-approval refreshes scope in BOTH stores — same id, one row each", async () => {
    const accountId = await makeAccount();
    const first = (await (await postGrant(accountId, GRANT_BODY)).json()) as {
      id: string;
    };
    // The owner re-approves with a narrowed scope (read-only bundle, no
    // explicit actions). Both stores must converge on it — a store keeping
    // the old scope would keep authorizing it on its side of the cutover.
    const res = await postGrant(accountId, {
      ...GRANT_BODY,
      actions: [],
      bundleIds: ["calendar.events.read"],
    });
    expect(res.status).toBe(200);
    const second = (await res.json()) as { id: string };
    expect(second.id).toBe(first.id);

    const grants = await prisma.connectionGrant.findMany({
      where: { ownerAccountId: accountId },
    });
    expect(grants).toHaveLength(1);
    expect(grants[0].actions).toEqual([]);
    expect(grants[0].bundleIds).toEqual(["calendar.events.read"]);

    const extensions = await prisma.conversationAbility.findMany({
      where: { entitlement: { is: { accountId } } },
    });
    expect(extensions).toHaveLength(1);
    expect(extensions[0].id).toBe(first.id);
    expect(extensions[0].actions).toEqual([]);
    expect(extensions[0].bundleIds).toEqual(["calendar.events.read"]);
  });

  test("a rejected POST leaves every store untouched (no partial state)", async () => {
    const accountId = await makeAccount();
    const res = await postGrant(accountId, {
      ...GRANT_BODY,
      bundleIds: ["calendar.bogus"],
    });
    expect(res.status).toBe(400);

    expect(
      await prisma.connectionGrant.count({
        where: { ownerAccountId: accountId },
      }),
    ).toBe(0);
    expect(
      await prisma.abilityEntitlement.count({ where: { accountId } }),
    ).toBe(0);
    expect(
      await prisma.conversationAbility.count({
        where: { entitlement: { is: { accountId } } },
      }),
    ).toBe(0);
  });
});

describe("V1 grant convergence — the check on both sides of the cutover", () => {
  test("the posted grant authorizes exec pre- and post-cutover; before it, neither side does", async () => {
    const accountId = await makeAccount();

    // Baseline: no grant yet — both stores must deny, or the allow below
    // proves nothing.
    for (const ready of [true, false]) {
      const denied = await withReadiness(ready, checkConversation);
      expect(denied).toEqual({ allowed: false, code: "no_grant" });
    }

    const res = await postGrant(accountId, GRANT_BODY);
    expect(res.status).toBe(200);
    const entitlement = await prisma.abilityEntitlement.findUniqueOrThrow({
      where: {
        accountId_abilityId: { accountId, abilityId: "googlecalendar" },
      },
    });

    // Post-cutover (readiness confirmed): the decision comes from the
    // entitlement tables — entitlementId names the row created by the POST.
    const postCutover = await withReadiness(true, checkConversation);
    expect(postCutover.allowed).toBe(true);
    if (postCutover.allowed) {
      expect(postCutover.ownerAccountId).toBe(accountId);
      expect(postCutover.entitlementId).toBe(entitlement.id);
      expect(postCutover.actions).toContain("GOOGLECALENDAR_EVENTS_LIST");
    }

    // Pre-cutover (boot window): the same grant authorizes from the legacy
    // matcher — entitlementId null is that path's signature.
    const preCutover = await withReadiness(false, checkConversation);
    expect(preCutover.allowed).toBe(true);
    if (preCutover.allowed) {
      expect(preCutover.ownerAccountId).toBe(accountId);
      expect(preCutover.entitlementId).toBeNull();
      expect(preCutover.actions).toContain("GOOGLECALENDAR_EVENTS_LIST");
    }
  });

  test("revoking the grant denies on BOTH sides; the entitlement survives, the extension does not", async () => {
    const accountId = await makeAccount();
    const { id } = (await (await postGrant(accountId, GRANT_BODY)).json()) as {
      id: string;
    };

    const res = await fetch(`${baseURL}/api/v2/connections/grants/${id}`, {
      method: "DELETE",
      headers: { "X-Convos-AuthToken": await token(accountId) },
    });
    expect(res.status).toBe(204);

    // Row state after the revoke transaction: legacy soft-revoked (audit
    // trail), extension deleted, the account-level entitlement kept — it is
    // the connection binding, not the conversation opt-in.
    const grant = await prisma.connectionGrant.findUniqueOrThrow({
      where: { id },
    });
    expect(grant.revokedAt).not.toBeNull();
    expect(
      await prisma.conversationAbility.findUnique({ where: { id } }),
    ).toBeNull();
    const entitlement = await prisma.abilityEntitlement.findUniqueOrThrow({
      where: {
        accountId_abilityId: { accountId, abilityId: "googlecalendar" },
      },
    });
    expect(entitlement.status).toBe("active");

    // And the decision: no side of the cutover keeps authorizing — the
    // surviving entitlement alone must not, and the revoked legacy row must
    // not.
    for (const ready of [true, false]) {
      const denied = await withReadiness(ready, checkConversation);
      expect(denied).toEqual({ allowed: false, code: "no_grant" });
    }
  });
});
