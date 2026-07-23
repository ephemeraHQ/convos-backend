import express from "express";
import request from "supertest";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { issueConnectionGrant } from "@/api/v2/connections/v1-grant-adapter";
import { conversationsRouter } from "@/api/v2/conversations/conversations.router";
import { authMiddleware, requireAccount } from "@/middleware/auth";
import { jsonMiddleware } from "@/middleware/json";
import { pinoMiddleware } from "@/middleware/pino";
import { createJwtToken, validateJWTKeys } from "@/utils/jwt";
import { prisma } from "@/utils/prisma";

vi.mock("firebase-admin/app");
vi.mock("firebase-admin/app-check");
vi.mock("firebase-admin/messaging");

// Mirrors the production wiring: the whole namespace is authMiddleware +
// requireAccount.
function makeApp() {
  const app = express();
  app.use(pinoMiddleware);
  app.use(jsonMiddleware);
  app.use(
    "/conversations",
    authMiddleware,
    requireAccount,
    conversationsRouter,
  );
  return app;
}

const CONVERSATION = "conv-ext-1";

const accountIds: string[] = [];

async function makeAccount(): Promise<string> {
  const account = await prisma.account.create({ data: {} });
  accountIds.push(account.id);
  return account.id;
}

async function makeActiveEntitlement(accountId: string) {
  return prisma.abilityEntitlement.create({
    data: { accountId, abilityId: "googlecalendar", status: "active" },
  });
}

function token(accountId?: string): Promise<string> {
  return createJwtToken({ deviceId: "device-conv-abilities", accountId });
}

async function putAbility(
  accountId: string,
  body: unknown,
  opts: { conversationId?: string; abilityId?: string } = {},
) {
  return request(makeApp())
    .put(
      `/conversations/${opts.conversationId ?? CONVERSATION}/abilities/${opts.abilityId ?? "googlecalendar"}`,
    )
    .set("X-Convos-AuthToken", await token(accountId))
    .send(body as object);
}

beforeAll(async () => {
  await validateJWTKeys();
});

afterEach(async () => {
  await prisma.connectionGrant.deleteMany({
    where: { ownerAccountId: { in: accountIds } },
  });
  // Cascades entitlements + extensions.
  await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
  accountIds.length = 0;
});

describe("PUT /v2/conversations/:conversationId/abilities/:abilityId", () => {
  test("403 for a device-only token (requireAccount)", async () => {
    const res = await request(makeApp())
      .put(`/conversations/${CONVERSATION}/abilities/googlecalendar`)
      .set("X-Convos-AuthToken", await token())
      .send({ agentInboxId: "agent-1", bundleIds: ["calendar.events"] });
    expect(res.status).toBe(403);
  });

  test("409 needs_entitlement without an entitlement, and for every non-active state", async () => {
    const accountId = await makeAccount();
    // No row at all.
    let res = await putAbility(accountId, {
      agentInboxId: "agent-1",
      bundleIds: ["calendar.events"],
    });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ code: "needs_entitlement" });

    for (const status of ["pending_auth", "needs_reauth", "expired"]) {
      await prisma.abilityEntitlement.upsert({
        where: {
          accountId_abilityId: { accountId, abilityId: "googlecalendar" },
        },
        create: { accountId, abilityId: "googlecalendar", status },
        update: { status, revokedAt: null },
      });
      res = await putAbility(accountId, {
        agentInboxId: "agent-1",
        bundleIds: ["calendar.events"],
      });
      expect(res.status).toBe(409);
      expect(res.body).toEqual({ code: "needs_entitlement" });
    }

    // A revoked tombstone is not extendable either.
    await prisma.abilityEntitlement.update({
      where: {
        accountId_abilityId: { accountId, abilityId: "googlecalendar" },
      },
      data: { status: "revoked", revokedAt: new Date() },
    });
    res = await putAbility(accountId, {
      agentInboxId: "agent-1",
      bundleIds: ["calendar.events"],
    });
    expect(res.status).toBe(409);
  });

  test("extends an active entitlement and answers the entry", async () => {
    const accountId = await makeAccount();
    const entitlement = await makeActiveEntitlement(accountId);
    const res = await putAbility(accountId, {
      agentInboxId: "agent-1",
      bundleIds: ["calendar.events"],
      extendedByInboxId: "owner-inbox-1",
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      abilityId: "googlecalendar",
      conversationId: CONVERSATION,
      agentInboxId: "agent-1",
      bundleIds: ["calendar.events"],
      extendedByInboxId: "owner-inbox-1",
      extendedByMe: true,
      status: "active",
    });

    const rows = await prisma.conversationAbility.findMany({
      where: { entitlementId: entitlement.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].bundleIds).toEqual(["calendar.events"]);
    // V2 writes never produce the legacy whole-toolkit shape.
    expect(rows[0].actions).toEqual([]);
  });

  test("re-PUT updates the same opt-in (idempotent per (ability, agent))", async () => {
    const accountId = await makeAccount();
    const entitlement = await makeActiveEntitlement(accountId);
    await putAbility(accountId, {
      agentInboxId: "agent-1",
      bundleIds: ["calendar.events"],
    });
    const res = await putAbility(accountId, {
      agentInboxId: "agent-1",
      bundleIds: ["calendar.events.read"],
    });
    expect(res.status).toBe(200);
    const rows = await prisma.conversationAbility.findMany({
      where: { entitlementId: entitlement.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].bundleIds).toEqual(["calendar.events.read"]);
  });

  test("a second agent never inherits: it gets its own row", async () => {
    const accountId = await makeAccount();
    const entitlement = await makeActiveEntitlement(accountId);
    await putAbility(accountId, {
      agentInboxId: "agent-1",
      bundleIds: ["calendar.events"],
    });
    await putAbility(accountId, {
      agentInboxId: "agent-2",
      bundleIds: ["calendar.events.read"],
    });
    const rows = await prisma.conversationAbility.findMany({
      where: { entitlementId: entitlement.id },
      orderBy: { agentInboxId: "asc" },
    });
    expect(rows).toHaveLength(2);
    expect(rows[0].agentInboxId).toBe("agent-1");
    expect(rows[1].agentInboxId).toBe("agent-2");
  });

  test("400 unknown_bundle on a stale bundle id; empty bundleIds is invalid_request", async () => {
    const accountId = await makeAccount();
    await makeActiveEntitlement(accountId);
    let res = await putAbility(accountId, {
      agentInboxId: "agent-1",
      bundleIds: ["calendar.bogus"],
    });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      code: "unknown_bundle",
      bundleId: "calendar.bogus",
    });

    // An empty scope would collide with the legacy whole-toolkit default in
    // the check — a V2 write must never produce it.
    res = await putAbility(accountId, {
      agentInboxId: "agent-1",
      bundleIds: [],
    });
    expect(res.status).toBe(400);
    expect((res.body as { code: string }).code).toBe("invalid_request");
  });

  test("404 unknown_ability for unknown and hidden abilities", async () => {
    const accountId = await makeAccount();
    for (const abilityId of ["notarealability", "gmail"]) {
      const res = await putAbility(
        accountId,
        { agentInboxId: "agent-1", bundleIds: ["calendar.events"] },
        { abilityId },
      );
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ code: "unknown_ability" });
    }
  });
});

describe("DELETE /v2/conversations/:conversationId/abilities/:abilityId", () => {
  test("withdraws one agent's opt-in and mirrors into the legacy grant", async () => {
    const accountId = await makeAccount();
    // Seeded V1-style so a legacy row exists to observe the mirror on.
    const grant = await issueConnectionGrant({
      accountId,
      ownerInboxId: "owner-inbox-1",
      granteeInboxId: "agent-1",
      conversationId: CONVERSATION,
      toolkit: "googlecalendar",
      bundleIds: ["calendar.events"],
    });

    const res = await request(makeApp())
      .delete(
        `/conversations/${CONVERSATION}/abilities/googlecalendar?agentInboxId=agent-1`,
      )
      .set("X-Convos-AuthToken", await token(accountId));
    expect(res.status).toBe(204);

    const extension = await prisma.conversationAbility.findUnique({
      where: { id: grant.id },
    });
    expect(extension).toBeNull();
    const legacy = await prisma.connectionGrant.findUnique({
      where: { id: grant.id },
    });
    expect(legacy!.revokedAt).not.toBeNull();

    // Idempotence boundary: the opt-in is gone, a second withdraw is 404.
    const again = await request(makeApp())
      .delete(
        `/conversations/${CONVERSATION}/abilities/googlecalendar?agentInboxId=agent-1`,
      )
      .set("X-Convos-AuthToken", await token(accountId));
    expect(again.status).toBe(404);
  });

  test("400 without agentInboxId; scoping cannot touch another member's opt-in", async () => {
    const owner = await makeAccount();
    const other = await makeAccount();
    await makeActiveEntitlement(owner);
    await makeActiveEntitlement(other);
    await putAbility(owner, {
      agentInboxId: "agent-1",
      bundleIds: ["calendar.events"],
    });

    const missing = await request(makeApp())
      .delete(`/conversations/${CONVERSATION}/abilities/googlecalendar`)
      .set("X-Convos-AuthToken", await token(owner));
    expect(missing.status).toBe(400);

    // `other` holds an entitlement but no opt-in here; the delete must not
    // reach the owner's row.
    const res = await request(makeApp())
      .delete(
        `/conversations/${CONVERSATION}/abilities/googlecalendar?agentInboxId=agent-1`,
      )
      .set("X-Convos-AuthToken", await token(other));
    expect(res.status).toBe(404);
    const rows = await prisma.conversationAbility.findMany({
      where: { conversationId: CONVERSATION },
    });
    expect(rows).toHaveLength(1);
  });
});

describe("GET /v2/conversations/:conversationId/abilities", () => {
  test("403 for a device-only token (requireAccount)", async () => {
    const res = await request(makeApp())
      .get(`/conversations/${CONVERSATION}/abilities`)
      .set("X-Convos-AuthToken", await token());
    expect(res.status).toBe(403);
  });

  test("serves every member's opt-ins with extendedByMe flags and entitlement status — no account ids", async () => {
    const caller = await makeAccount();
    const member = await makeAccount();
    await makeActiveEntitlement(caller);
    await putAbility(caller, {
      agentInboxId: "agent-1",
      bundleIds: ["calendar.events"],
      extendedByInboxId: "caller-inbox",
    });
    // The other member's opt-in, with a non-active entitlement status.
    const memberEntitlement = await prisma.abilityEntitlement.create({
      data: {
        accountId: member,
        abilityId: "googlecalendar",
        status: "needs_reauth",
      },
    });
    await prisma.conversationAbility.create({
      data: {
        entitlementId: memberEntitlement.id,
        conversationId: CONVERSATION,
        agentInboxId: "agent-1",
        bundleIds: ["calendar.events.read"],
        extendedByInboxId: "member-inbox",
      },
    });
    // A different conversation must not bleed in.
    await prisma.conversationAbility.create({
      data: {
        entitlementId: memberEntitlement.id,
        conversationId: "conv-elsewhere",
        agentInboxId: "agent-1",
        bundleIds: ["calendar.events"],
      },
    });

    const res = await request(makeApp())
      .get(`/conversations/${CONVERSATION}/abilities`)
      .set("X-Convos-AuthToken", await token(caller));
    expect(res.status).toBe(200);
    const { abilities } = res.body as {
      abilities: Array<Record<string, unknown>>;
    };
    expect(abilities).toHaveLength(2);

    const mine = abilities.find((a) => a.extendedByInboxId === "caller-inbox");
    const theirs = abilities.find(
      (a) => a.extendedByInboxId === "member-inbox",
    );
    expect(mine).toMatchObject({
      abilityId: "googlecalendar",
      agentInboxId: "agent-1",
      bundleIds: ["calendar.events"],
      extendedByMe: true,
      status: "active",
    });
    expect(theirs).toMatchObject({
      bundleIds: ["calendar.events.read"],
      extendedByMe: false,
      status: "needs_reauth",
    });

    // Bounded payload: no backend account ids, credential ids, or raw slugs.
    const payload = JSON.stringify(res.body);
    expect(payload).not.toContain(caller);
    expect(payload).not.toContain(member);
    expect(payload).not.toMatch(/GOOGLECALENDAR_/);
  });

  test("empty conversation answers an empty list", async () => {
    const accountId = await makeAccount();
    const res = await request(makeApp())
      .get("/conversations/conv-nothing-here/abilities")
      .set("X-Convos-AuthToken", await token(accountId));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ abilities: [] });
  });
});
