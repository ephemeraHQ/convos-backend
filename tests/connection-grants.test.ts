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
});
