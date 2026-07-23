import express from "express";
import request from "supertest";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { abilitiesRouter } from "@/api/v2/abilities/abilities.router";
import { getServedAbilityVersion } from "@/api/v2/abilities/manifests.config";
import {
  __resetComposioServiceForTests,
  ComposioService,
} from "@/api/v2/connections/composio.service";
import { issueConnectionGrant } from "@/api/v2/connections/v1-grant-adapter";
import { authMiddleware } from "@/middleware/auth";
import { jsonMiddleware } from "@/middleware/json";
import { pinoMiddleware } from "@/middleware/pino";
import { createJwtToken, validateJWTKeys } from "@/utils/jwt";
import { prisma } from "@/utils/prisma";

vi.mock("firebase-admin/app");
vi.mock("firebase-admin/app-check");
vi.mock("firebase-admin/messaging");

// Mirrors the production wiring: the mount is authMiddleware-only, the
// entitlement routes apply requireAccount per-route.
function makeApp() {
  const app = express();
  app.use(pinoMiddleware);
  app.use(jsonMiddleware);
  app.use("/abilities", authMiddleware, abilitiesRouter);
  return app;
}

type StubConnection = { id: string; userId: string; slug: string };

// Lifecycle endpoints touch authConfigs.list (bind), connectedAccounts.link
// (bind), connectedAccounts.list (complete ownership + revoke inventory) and
// connectedAccounts.delete (revoke teardown).
function installComposioStub(
  opts: {
    authConfigId?: string | null;
    linkRedirectUrl?: string;
    connections?: StubConnection[];
    listThrows?: boolean;
    deleted?: string[];
  } = {},
) {
  const stub = {
    authConfigs: {
      list: (_query: { toolkit: string }) =>
        Promise.resolve({
          items:
            opts.authConfigId === null
              ? []
              : [
                  {
                    id: opts.authConfigId ?? "ac_googlecalendar",
                    toolkit: { slug: "googlecalendar" },
                    status: "ENABLED",
                    isComposioManaged: true,
                  },
                ],
          totalPages: 1,
        }),
    },
    connectedAccounts: {
      link: (_userId: string, _authConfigId: string, _opts: unknown) =>
        Promise.resolve({
          id: "creq_1",
          status: "INITIATED",
          redirectUrl: opts.linkRedirectUrl ?? "https://composio.test/oauth",
        }),
      list: (query: { userIds?: string[] }) => {
        if (opts.listThrows) {
          return Promise.reject(new Error("composio down"));
        }
        const wanted = query.userIds ?? [];
        const items = (opts.connections ?? [])
          .filter((c) => wanted.includes(c.userId))
          .map((c) => ({
            id: c.id,
            status: "ACTIVE",
            toolkit: { slug: c.slug },
          }));
        return Promise.resolve({ items, totalPages: 1, nextCursor: null });
      },
      delete: (id: string) => {
        opts.deleted?.push(id);
        return Promise.resolve({});
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

const accountIds: string[] = [];

async function makeAccount(): Promise<string> {
  const account = await prisma.account.create({ data: {} });
  accountIds.push(account.id);
  return account.id;
}

function token(accountId?: string): Promise<string> {
  return createJwtToken({ deviceId: "device-entitlement", accountId });
}

beforeAll(async () => {
  await validateJWTKeys();
});

afterEach(async () => {
  __resetComposioServiceForTests(null);
  await prisma.connectionGrant.deleteMany({
    where: { ownerAccountId: { in: accountIds } },
  });
  // Cascades entitlements + extensions.
  await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
  accountIds.length = 0;
});

describe("POST /v2/abilities/:abilityId/entitlement", () => {
  test("403 for a device-only token (requireAccount)", async () => {
    const res = await request(makeApp())
      .post("/abilities/googlecalendar/entitlement")
      .set("X-Convos-AuthToken", await token())
      .send({});
    expect(res.status).toBe(403);
  });

  test("404 unknown_ability for unknown and for hidden (unlaunched) abilities", async () => {
    const accountId = await makeAccount();
    for (const abilityId of ["notarealability", "gmail"]) {
      const res = await request(makeApp())
        .post(`/abilities/${abilityId}/entitlement`)
        .set("X-Convos-AuthToken", await token(accountId))
        .send({});
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ code: "unknown_ability" });
    }
  });

  test("starts the OAuth flow and upserts a pending_auth entitlement", async () => {
    const accountId = await makeAccount();
    installComposioStub();
    const res = await request(makeApp())
      .post("/abilities/googlecalendar/entitlement")
      .set("X-Convos-AuthToken", await token(accountId))
      .send({ redirectUri: "convos-dev://connections/callback" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: "pending_auth",
      redirectUrl: "https://composio.test/oauth",
      connectionRequestId: "creq_1",
    });

    const row = await prisma.abilityEntitlement.findUnique({
      where: {
        accountId_abilityId: { accountId, abilityId: "googlecalendar" },
      },
    });
    expect(row!.status).toBe("pending_auth");
    expect(row!.abilityVersion).toBe(getServedAbilityVersion("googlecalendar"));
    expect(row!.revokedAt).toBeNull();
  });

  test("idempotent restart: an active entitlement stays active while re-auth is in flight", async () => {
    const accountId = await makeAccount();
    await prisma.abilityEntitlement.create({
      data: { accountId, abilityId: "googlecalendar", status: "active" },
    });
    installComposioStub();
    const res = await request(makeApp())
      .post("/abilities/googlecalendar/entitlement")
      .set("X-Convos-AuthToken", await token(accountId))
      .send({});
    expect(res.status).toBe(200);
    const body = res.body as { status: string; connectionRequestId: string };
    expect(body.status).toBe("active");
    expect(body.connectionRequestId).toBe("creq_1");
    const row = await prisma.abilityEntitlement.findUnique({
      where: {
        accountId_abilityId: { accountId, abilityId: "googlecalendar" },
      },
    });
    expect(row!.status).toBe("active");
  });

  test("binding again clears a revocation tombstone (explicit user action)", async () => {
    const accountId = await makeAccount();
    await prisma.abilityEntitlement.create({
      data: {
        accountId,
        abilityId: "googlecalendar",
        status: "revoked",
        revokedAt: new Date(),
      },
    });
    installComposioStub();
    const res = await request(makeApp())
      .post("/abilities/googlecalendar/entitlement")
      .set("X-Convos-AuthToken", await token(accountId))
      .send({});
    expect(res.status).toBe(200);
    expect((res.body as { status: string }).status).toBe("pending_auth");
    const row = await prisma.abilityEntitlement.findUnique({
      where: {
        accountId_abilityId: { accountId, abilityId: "googlecalendar" },
      },
    });
    expect(row!.status).toBe("pending_auth");
    expect(row!.revokedAt).toBeNull();
  });

  test("502 auth_config_unavailable when Composio has no ENABLED config", async () => {
    const accountId = await makeAccount();
    installComposioStub({ authConfigId: null });
    const res = await request(makeApp())
      .post("/abilities/googlecalendar/entitlement")
      .set("X-Convos-AuthToken", await token(accountId))
      .send({});
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ code: "auth_config_unavailable" });
    const row = await prisma.abilityEntitlement.findUnique({
      where: {
        accountId_abilityId: { accountId, abilityId: "googlecalendar" },
      },
    });
    expect(row).toBeNull();
  });
});

describe("POST /v2/abilities/:abilityId/entitlement/complete", () => {
  test("verifies ownership and flips the entitlement to active with the credential ref", async () => {
    const accountId = await makeAccount();
    await prisma.abilityEntitlement.create({
      data: { accountId, abilityId: "googlecalendar", status: "pending_auth" },
    });
    installComposioStub({
      connections: [
        { id: "creq_1", userId: accountId, slug: "googlecalendar" },
      ],
    });
    const res = await request(makeApp())
      .post("/abilities/googlecalendar/entitlement/complete")
      .set("X-Convos-AuthToken", await token(accountId))
      .send({ connectionRequestId: "creq_1" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "active" });

    const row = await prisma.abilityEntitlement.findUnique({
      where: {
        accountId_abilityId: { accountId, abilityId: "googlecalendar" },
      },
    });
    expect(row!.status).toBe("active");
    expect(row!.externalConnectionId).toBe("creq_1");
  });

  test("403 connection_not_owned when the connection is not the caller's", async () => {
    const accountId = await makeAccount();
    installComposioStub({ connections: [] });
    const res = await request(makeApp())
      .post("/abilities/googlecalendar/entitlement/complete")
      .set("X-Convos-AuthToken", await token(accountId))
      .send({ connectionRequestId: "creq_foreign" });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ code: "connection_not_owned" });
  });

  test("409 ability_mismatch when the connection belongs to another toolkit", async () => {
    const accountId = await makeAccount();
    installComposioStub({
      connections: [{ id: "creq_1", userId: accountId, slug: "spotify" }],
    });
    const res = await request(makeApp())
      .post("/abilities/googlecalendar/entitlement/complete")
      .set("X-Convos-AuthToken", await token(accountId))
      .send({ connectionRequestId: "creq_1" });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ code: "ability_mismatch" });
  });
});

describe("DELETE /v2/abilities/:abilityId/entitlement", () => {
  test("revokes: external credentials deleted (all duplicates), extensions gone, legacy grants revoked, tombstone kept", async () => {
    const accountId = await makeAccount();
    // A V1-issued grant creates the entitlement + extension + legacy row.
    await issueConnectionGrant({
      accountId,
      ownerInboxId: "owner-inbox",
      granteeInboxId: "agent-inbox",
      conversationId: "conv-rev",
      toolkit: "googlecalendar",
      bundleIds: ["calendar.events"],
    });
    const deleted: string[] = [];
    installComposioStub({
      deleted,
      connections: [
        { id: "conn_a", userId: accountId, slug: "googlecalendar" },
        { id: "conn_dup", userId: accountId, slug: "googlecalendar" },
        { id: "conn_other", userId: accountId, slug: "spotify" },
      ],
    });

    const res = await request(makeApp())
      .delete("/abilities/googlecalendar/entitlement")
      .set("X-Convos-AuthToken", await token(accountId));
    expect(res.status).toBe(204);

    // Multi-credential rule: every googlecalendar connection went; spotify
    // was untouched.
    expect(deleted.sort()).toEqual(["conn_a", "conn_dup"]);

    const row = await prisma.abilityEntitlement.findUnique({
      where: {
        accountId_abilityId: { accountId, abilityId: "googlecalendar" },
      },
      include: { extensions: true },
    });
    expect(row!.status).toBe("revoked");
    expect(row!.revokedAt).not.toBeNull();
    expect(row!.externalConnectionId).toBeNull();
    expect(row!.extensions).toHaveLength(0);

    const grants = await prisma.connectionGrant.findMany({
      where: { ownerAccountId: accountId },
    });
    expect(grants.every((g) => g.revokedAt !== null)).toBe(true);
  });

  test("404 when the ability was never bound", async () => {
    const accountId = await makeAccount();
    const res = await request(makeApp())
      .delete("/abilities/googlecalendar/entitlement")
      .set("X-Convos-AuthToken", await token(accountId));
    expect(res.status).toBe(404);
  });

  test("502 revoke_failed on a Composio outage — entitlement untouched", async () => {
    const accountId = await makeAccount();
    await prisma.abilityEntitlement.create({
      data: {
        accountId,
        abilityId: "googlecalendar",
        status: "active",
        externalConnectionId: "conn_a",
      },
    });
    installComposioStub({ listThrows: true });
    const res = await request(makeApp())
      .delete("/abilities/googlecalendar/entitlement")
      .set("X-Convos-AuthToken", await token(accountId));
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ code: "revoke_failed" });
    const row = await prisma.abilityEntitlement.findUnique({
      where: {
        accountId_abilityId: { accountId, abilityId: "googlecalendar" },
      },
    });
    expect(row!.status).toBe("active");
    expect(row!.revokedAt).toBeNull();
    expect(row!.externalConnectionId).toBe("conn_a");
  });

  test("idempotent: deleting an already-revoked entitlement is 204 again", async () => {
    const accountId = await makeAccount();
    await prisma.abilityEntitlement.create({
      data: {
        accountId,
        abilityId: "googlecalendar",
        status: "revoked",
        revokedAt: new Date(),
      },
    });
    installComposioStub({ connections: [] });
    const res = await request(makeApp())
      .delete("/abilities/googlecalendar/entitlement")
      .set("X-Convos-AuthToken", await token(accountId));
    expect(res.status).toBe(204);
  });
});
