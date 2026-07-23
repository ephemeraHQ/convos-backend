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
import { connectionsRouter } from "@/api/v2/connections/connections.router";
import { authMiddleware, requireAccount } from "@/middleware/auth";
import { jsonMiddleware } from "@/middleware/json";
import { pinoMiddleware } from "@/middleware/pino";
import { createJwtToken } from "@/utils/jwt";
import { prisma } from "@/utils/prisma";

vi.mock("firebase-admin/app");
vi.mock("firebase-admin/app-check");
vi.mock("firebase-admin/messaging");

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
const baseURL = "http://localhost:4015";

const accountIds: string[] = [];

async function makeAccount(): Promise<string> {
  const account = await prisma.account.create({ data: {} });
  accountIds.push(account.id);
  return account.id;
}

function token(accountId: string): Promise<string> {
  return createJwtToken({ deviceId: "device-grants", accountId });
}

async function asJson<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
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

const GRANT_BODY = {
  ownerInboxId: "owner-inbox",
  granteeInboxId: "agent-inbox",
  conversationId: "conv-1",
  toolkit: "googlecalendar",
  actions: ["GOOGLECALENDAR_EVENTS_LIST"],
  connectionId: "conn_1",
};

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server = app.listen(4015, () => {
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
});

afterEach(async () => {
  await prisma.connectionGrant.deleteMany({
    where: { ownerAccountId: { in: accountIds } },
  });
  await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
  accountIds.length = 0;
});

describe("Connection grants API", () => {
  test("403 when the device is not bound to an account", async () => {
    const tok = await createJwtToken({ deviceId: "device-grants" });
    const res = await fetch(`${baseURL}/api/v2/connections/grants`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Convos-AuthToken": tok,
      },
      body: JSON.stringify(GRANT_BODY),
    });
    expect(res.status).toBe(403);
  });

  test("issues a grant stamped with the JWT's accountId, and ignores a body connectionId (#2)", async () => {
    const accountId = await makeAccount();
    // GRANT_BODY carries a connectionId; the API must NOT persist it (a bearer
    // capability the client cannot be trusted to pin). Resolution is server-side.
    const res = await postGrant(accountId, GRANT_BODY);
    expect(res.status).toBe(200);
    const { id } = await asJson<{ id: string }>(res);

    const row = await prisma.connectionGrant.findUnique({ where: { id } });
    expect(row?.ownerAccountId).toBe(accountId);
    expect(row?.granteeInboxId).toBe("agent-inbox");
    expect(row?.connectionId).toBeNull();
  });

  test("re-issuing the same (owner, grantee, conversation, toolkit) upserts and un-revokes", async () => {
    const accountId = await makeAccount();
    const first = await asJson<{ id: string }>(
      await postGrant(accountId, GRANT_BODY),
    );
    // Revoke it, then re-issue — the row should come back live with new scope.
    await prisma.connectionGrant.update({
      where: { id: first.id },
      data: { revokedAt: new Date() },
    });
    const second = await asJson<{ id: string }>(
      await postGrant(accountId, { ...GRANT_BODY, actions: [] }),
    );
    expect(second.id).toBe(first.id);
    const row = await prisma.connectionGrant.findUnique({
      where: { id: first.id },
    });
    expect(row?.revokedAt).toBeNull();
    expect(row?.actions).toEqual([]);
  });

  test("GET lists only the caller's own grants and omits connectionId", async () => {
    const mine = await makeAccount();
    const other = await makeAccount();
    await postGrant(mine, GRANT_BODY);
    await postGrant(other, { ...GRANT_BODY, conversationId: "conv-other" });

    const res = await fetch(`${baseURL}/api/v2/connections/grants`, {
      headers: { "X-Convos-AuthToken": await token(mine) },
    });
    expect(res.status).toBe(200);
    const { grants } = await asJson<{
      grants: Array<{ conversationId: string }>;
    }>(res);
    expect(grants).toHaveLength(1);
    expect(grants[0].conversationId).toBe("conv-1");
    expect(grants[0]).not.toHaveProperty("connectionId");
  });

  test("GET returns bundleIds and never raw Composio action slugs", async () => {
    const mine = await makeAccount();
    // GRANT_BODY carries a raw slug in `actions`; the stored row has it, but
    // the wire must not — clients only ever reason in bundle ids.
    await postGrant(mine, { ...GRANT_BODY, bundleIds: ["calendar.events"] });

    const res = await fetch(`${baseURL}/api/v2/connections/grants`, {
      headers: { "X-Convos-AuthToken": await token(mine) },
    });
    expect(res.status).toBe(200);
    const raw = await res.text();
    expect(raw).not.toMatch(/GOOGLECALENDAR_/);
    const { grants } = JSON.parse(raw) as {
      grants: Array<{ bundleIds?: string[] }>;
    };
    expect(grants).toHaveLength(1);
    expect(grants[0]).not.toHaveProperty("actions");
    expect(grants[0].bundleIds).toEqual(["calendar.events"]);
  });

  test("POST persists catalog-known bundleIds (incl. DEPRECATED ones); unknown ones are 400 unknown_bundle", async () => {
    const accountId = await makeAccount();
    // calendar.events.read is deprecated (hidden from the public catalog since
    // googlecalendar v4) but MUST stay grantable: old clients may round-trip
    // it from a cached catalog until their TTL expires.
    const ok = await postGrant(accountId, {
      ...GRANT_BODY,
      actions: [],
      bundleIds: ["calendar.events.read"],
      serviceVersion: 2,
    });
    expect(ok.status).toBe(200);
    const { id } = await asJson<{ id: string }>(ok);
    const row = await prisma.connectionGrant.findUnique({ where: { id } });
    expect(row?.bundleIds).toEqual(["calendar.events.read"]);
    expect(row?.serviceVersion).toBe(2);

    // Validation is also covered no-DB in connection-grants-validation.test.ts;
    // this asserts the full HTTP wiring rejects before any write.
    const bad = await postGrant(accountId, {
      ...GRANT_BODY,
      conversationId: "conv-bad",
      bundleIds: ["calendar.bogus"],
    });
    expect(bad.status).toBe(400);
    expect(await asJson<{ code: string; bundleId: string }>(bad)).toEqual({
      code: "unknown_bundle",
      bundleId: "calendar.bogus",
    });
  });

  test("DELETE revokes the caller's own grant (soft-delete)", async () => {
    const accountId = await makeAccount();
    const { id } = await asJson<{ id: string }>(
      await postGrant(accountId, GRANT_BODY),
    );
    const res = await fetch(`${baseURL}/api/v2/connections/grants/${id}`, {
      method: "DELETE",
      headers: { "X-Convos-AuthToken": await token(accountId) },
    });
    expect(res.status).toBe(204);
    const row = await prisma.connectionGrant.findUnique({ where: { id } });
    expect(row?.revokedAt).not.toBeNull();
  });

  test("DELETE cannot revoke another account's grant (404, not touched)", async () => {
    const owner = await makeAccount();
    const attacker = await makeAccount();
    const { id } = await asJson<{ id: string }>(
      await postGrant(owner, GRANT_BODY),
    );

    const res = await fetch(`${baseURL}/api/v2/connections/grants/${id}`, {
      method: "DELETE",
      headers: { "X-Convos-AuthToken": await token(attacker) },
    });
    expect(res.status).toBe(404);
    const row = await prisma.connectionGrant.findUnique({ where: { id } });
    expect(row?.revokedAt).toBeNull();
  });

  test("a DELETE retry heals a surviving extension when the legacy row is already revoked", async () => {
    const accountId = await makeAccount();
    const { id } = await asJson<{ id: string }>(
      await postGrant(accountId, GRANT_BODY),
    );
    // Divergent state a pre-transaction failure (or an old replica) could
    // leave: legacy already revoked, extension still authorizing.
    await prisma.connectionGrant.update({
      where: { id },
      data: { revokedAt: new Date() },
    });
    const before = await prisma.conversationAbility.findUnique({
      where: { id },
    });
    expect(before).not.toBeNull();

    const res = await fetch(`${baseURL}/api/v2/connections/grants/${id}`, {
      method: "DELETE",
      headers: { "X-Convos-AuthToken": await token(accountId) },
    });
    // The wire keeps the V1 contract (already-revoked reads as not found),
    // but the retry converges the stores: the extension is gone.
    expect(res.status).toBe(404);
    const after = await prisma.conversationAbility.findUnique({
      where: { id },
    });
    expect(after).toBeNull();
  });

  async function postRevoke(
    accountId: string,
    body: { toolkit: string; conversationId?: string; granteeInboxId?: string },
  ) {
    return fetch(`${baseURL}/api/v2/connections/grants/revoke`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Convos-AuthToken": await token(accountId),
      },
      body: JSON.stringify(body),
    });
  }

  test("revoke-by-natural-key revokes a stranded grant without its id (#4)", async () => {
    const accountId = await makeAccount();
    // Simulate the strand: backend grant is live, the client lost its id.
    await postGrant(accountId, GRANT_BODY);
    const res = await postRevoke(accountId, {
      toolkit: GRANT_BODY.toolkit,
      conversationId: GRANT_BODY.conversationId,
      granteeInboxId: GRANT_BODY.granteeInboxId,
    });
    expect(res.status).toBe(200);
    expect((await asJson<{ revoked: number }>(res)).revoked).toBe(1);
    const rows = await prisma.connectionGrant.findMany({
      where: { ownerAccountId: accountId },
    });
    expect(rows.every((r) => r.revokedAt !== null)).toBe(true);
  });

  test("revoke by toolkit alone clears every grant for that connection", async () => {
    const accountId = await makeAccount();
    await postGrant(accountId, GRANT_BODY);
    await postGrant(accountId, {
      ...GRANT_BODY,
      conversationId: "conv-2",
      granteeInboxId: "agent-2",
    });
    const res = await postRevoke(accountId, { toolkit: GRANT_BODY.toolkit });
    expect((await asJson<{ revoked: number }>(res)).revoked).toBe(2);
  });

  test("revoke-by-natural-key cannot touch another account's grants", async () => {
    const owner = await makeAccount();
    const attacker = await makeAccount();
    await postGrant(owner, GRANT_BODY);

    const res = await postRevoke(attacker, {
      toolkit: GRANT_BODY.toolkit,
      conversationId: GRANT_BODY.conversationId,
    });
    expect(res.status).toBe(200);
    expect((await asJson<{ revoked: number }>(res)).revoked).toBe(0);
    const rows = await prisma.connectionGrant.findMany({
      where: { ownerAccountId: owner },
    });
    expect(rows.every((r) => r.revokedAt === null)).toBe(true);
  });
});
