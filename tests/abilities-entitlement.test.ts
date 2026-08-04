import express from "express";
import request from "supertest";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { abilitiesRouter } from "@/api/v2/abilities/abilities.router";
import { getServedAbilityVersion } from "@/api/v2/abilities/manifests.config";
import {
  __resetComposioServiceForTests,
  __setComposioServiceUnconfiguredForTests,
  ComposioService,
} from "@/api/v2/connections/composio.service";
import { noteV1ConnectionCompleted } from "@/api/v2/connections/v1-connection-adapter";
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

type StubConnection = {
  id: string;
  userId: string;
  slug: string;
  status?: string;
};

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
            status: c.status ?? "ACTIVE",
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

  test("409 auth_incomplete for an owned but not-yet-ACTIVE connection — the entitlement stays pending_auth", async () => {
    // A complete fired right after initiate: the connection is owned but
    // OAuth has not finished. Persisting active here would let the catalog
    // and conversation PUT treat an unusable credential as connected.
    const accountId = await makeAccount();
    await prisma.abilityEntitlement.create({
      data: { accountId, abilityId: "googlecalendar", status: "pending_auth" },
    });
    for (const composioStatus of ["INITIALIZING", "INITIATED"]) {
      installComposioStub({
        connections: [
          {
            id: "creq_1",
            userId: accountId,
            slug: "googlecalendar",
            status: composioStatus,
          },
        ],
      });
      const res = await request(makeApp())
        .post("/abilities/googlecalendar/entitlement/complete")
        .set("X-Convos-AuthToken", await token(accountId))
        .send({ connectionRequestId: "creq_1" });
      expect(res.status).toBe(409);
      expect(res.body).toEqual({
        code: "auth_incomplete",
        status: "pending_auth",
      });
      const row = await prisma.abilityEntitlement.findUniqueOrThrow({
        where: {
          accountId_abilityId: { accountId, abilityId: "googlecalendar" },
        },
      });
      expect(row.status).toBe("pending_auth");
      expect(row.externalConnectionId).toBeNull();
    }

    // The retry after OAuth really finishes activates as usual.
    installComposioStub({
      connections: [
        { id: "creq_1", userId: accountId, slug: "googlecalendar" },
      ],
    });
    const done = await request(makeApp())
      .post("/abilities/googlecalendar/entitlement/complete")
      .set("X-Convos-AuthToken", await token(accountId))
      .send({ connectionRequestId: "creq_1" });
    expect(done.status).toBe(200);
    expect(done.body).toEqual({ status: "active" });
  });

  test("a FAILED connection maps to expired in the auth_incomplete answer and never activates", async () => {
    const accountId = await makeAccount();
    installComposioStub({
      connections: [
        {
          id: "creq_1",
          userId: accountId,
          slug: "googlecalendar",
          status: "FAILED",
        },
      ],
    });
    const res = await request(makeApp())
      .post("/abilities/googlecalendar/entitlement/complete")
      .set("X-Convos-AuthToken", await token(accountId))
      .send({ connectionRequestId: "creq_1" });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ code: "auth_incomplete", status: "expired" });
    const row = await prisma.abilityEntitlement.findUnique({
      where: {
        accountId_abilityId: { accountId, abilityId: "googlecalendar" },
      },
    });
    expect(row).toBeNull();
  });
});

describe("noteV1ConnectionCompleted (V1 mirror)", () => {
  test("derives the mirrored status from the connection — non-active never writes active", async () => {
    const accountId = await makeAccount();
    // Still in-flight: the mirror records pending_auth, no credential ref.
    await noteV1ConnectionCompleted({
      accountId,
      connectionId: "conn_pending",
      toolkitSlug: "googlecalendar",
      connectionStatus: "INITIATED",
    });
    let row = await prisma.abilityEntitlement.findUniqueOrThrow({
      where: {
        accountId_abilityId: { accountId, abilityId: "googlecalendar" },
      },
    });
    expect(row.status).toBe("pending_auth");
    expect(row.externalConnectionId).toBeNull();

    // Verified ACTIVE: activates and records the credential.
    await noteV1ConnectionCompleted({
      accountId,
      connectionId: "conn_live",
      toolkitSlug: "googlecalendar",
      connectionStatus: "ACTIVE",
    });
    row = await prisma.abilityEntitlement.findUniqueOrThrow({
      where: {
        accountId_abilityId: { accountId, abilityId: "googlecalendar" },
      },
    });
    expect(row.status).toBe("active");
    expect(row.externalConnectionId).toBe("conn_live");

    // A late non-active complete neither downgrades the active entitlement
    // (its credential still works) nor clears the ref.
    await noteV1ConnectionCompleted({
      accountId,
      connectionId: "conn_pending",
      toolkitSlug: "googlecalendar",
      connectionStatus: "INITIALIZING",
    });
    row = await prisma.abilityEntitlement.findUniqueOrThrow({
      where: {
        accountId_abilityId: { accountId, abilityId: "googlecalendar" },
      },
    });
    expect(row.status).toBe("active");
    expect(row.externalConnectionId).toBe("conn_live");
  });

  test("a non-active complete never resurrects a revocation tombstone", async () => {
    const accountId = await makeAccount();
    const revokedAt = new Date();
    await prisma.abilityEntitlement.create({
      data: {
        accountId,
        abilityId: "googlecalendar",
        status: "revoked",
        revokedAt,
      },
    });
    await noteV1ConnectionCompleted({
      accountId,
      connectionId: "conn_pending",
      toolkitSlug: "googlecalendar",
      connectionStatus: "INITIATED",
    });
    const row = await prisma.abilityEntitlement.findUniqueOrThrow({
      where: {
        accountId_abilityId: { accountId, abilityId: "googlecalendar" },
      },
    });
    expect(row.status).toBe("revoked");
    expect(row.revokedAt).toEqual(revokedAt);
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

  test("503 when Composio is unconfigured — entitlement untouched (teardown-first, same rule as an outage)", async () => {
    const accountId = await makeAccount();
    await prisma.abilityEntitlement.create({
      data: {
        accountId,
        abilityId: "googlecalendar",
        status: "active",
        externalConnectionId: "conn_a",
      },
    });
    __setComposioServiceUnconfiguredForTests();
    const res = await request(makeApp())
      .delete("/abilities/googlecalendar/entitlement")
      .set("X-Convos-AuthToken", await token(accountId));
    expect(res.status).toBe(503);
    // Never a tombstone over a possibly-live external credential.
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

describe("DELETE /v2/abilities/:abilityId/entitlement — concurrency and partial failure", () => {
  type LiveConnection = { id: string; userId: string; slug: string };
  type StatefulStubState = {
    connections: LiveConnection[];
    deleted: string[];
    /** Awaited at the top of every connectedAccounts.list call. */
    onList?: (call: number) => Promise<void> | void;
    /** Runs after a list call computed its snapshot (mutations here are
     * visible to LATER calls only). */
    afterListSnapshot?: (call: number) => void;
    onDelete?: (id: string) => void;
  };

  // The shared installComposioStub serves a fixed inventory; these races need
  // one whose list reflects deletions and whose calls can be gated.
  function installStatefulComposioStub(state: StatefulStubState) {
    let listCalls = 0;
    const stub = {
      authConfigs: {
        list: () => Promise.resolve({ items: [], totalPages: 1 }),
      },
      connectedAccounts: {
        link: () => Promise.reject(new Error("unused in these tests")),
        list: async (query: { userIds?: string[] }) => {
          listCalls += 1;
          const call = listCalls;
          await state.onList?.(call);
          const wanted = query.userIds ?? [];
          const items = state.connections
            .filter((c) => wanted.includes(c.userId))
            .map((c) => ({
              id: c.id,
              status: "ACTIVE",
              toolkit: { slug: c.slug },
            }));
          state.afterListSnapshot?.(call);
          return { items, totalPages: 1, nextCursor: null };
        },
        delete: (id: string) => {
          state.deleted.push(id);
          state.connections = state.connections.filter((c) => c.id !== id);
          state.onDelete?.(id);
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

  test("a complete racing a revoke cannot resurrect an active row over the deleted credential", async () => {
    const accountId = await makeAccount();
    await prisma.abilityEntitlement.create({
      data: {
        accountId,
        abilityId: "googlecalendar",
        status: "active",
        externalConnectionId: "conn_a",
      },
    });
    const deleted: string[] = [];
    let releaseComplete!: () => void;
    const completeGate = new Promise<void>((resolve) => {
      releaseComplete = resolve;
    });
    let signalCompleteInside!: () => void;
    const completeInside = new Promise<void>((resolve) => {
      signalCompleteInside = resolve;
    });
    let signalTeardownDone!: () => void;
    const teardownDone = new Promise<void>((resolve) => {
      signalTeardownDone = resolve;
    });
    installStatefulComposioStub({
      connections: [
        { id: "conn_a", userId: accountId, slug: "googlecalendar" },
      ],
      deleted,
      onList: async (call) => {
        if (call === 1) {
          // Complete's in-transaction ownership read: the entitlement row
          // lock is already held. Park it until the concurrent revoke has
          // finished its external teardown.
          signalCompleteInside();
          await completeGate;
        }
      },
      onDelete: (id) => {
        if (id === "conn_a") signalTeardownDone();
      },
    });

    // Complete first: its transaction takes the row lock, then its ownership
    // read parks on the gate.
    const completePromise = request(makeApp())
      .post("/abilities/googlecalendar/entitlement/complete")
      .set("X-Convos-AuthToken", await token(accountId))
      .send({ connectionRequestId: "conn_a" })
      .then((r) => r);
    await completeInside;

    // The revoke starts while complete is parked: its external teardown runs
    // (deleting conn_a), then its tombstone transaction queues on the row
    // lock held by complete.
    const deletePromise = request(makeApp())
      .delete("/abilities/googlecalendar/entitlement")
      .set("X-Convos-AuthToken", await token(accountId))
      .then((r) => r);
    await teardownDone;
    releaseComplete();

    const [completeRes, deleteRes] = await Promise.all([
      completePromise,
      deletePromise,
    ]);
    // Complete observed the concurrent teardown (its ownership read ran
    // after the credential died) and refused; the revoke then landed its
    // tombstone. No interleaving leaves an active row over a dead credential.
    expect(completeRes.status).toBe(403);
    expect(completeRes.body).toEqual({ code: "connection_not_owned" });
    expect(deleteRes.status).toBe(204);
    expect(deleted).toEqual(["conn_a"]);

    const row = await prisma.abilityEntitlement.findUnique({
      where: {
        accountId_abilityId: { accountId, abilityId: "googlecalendar" },
      },
    });
    expect(row!.status).toBe("revoked");
    expect(row!.revokedAt).not.toBeNull();
    expect(row!.externalConnectionId).toBeNull();
  });

  test("a credential appearing mid-revoke (a concurrent bind completing OAuth) is swept before the 204", async () => {
    const accountId = await makeAccount();
    await issueConnectionGrant({
      accountId,
      ownerInboxId: "owner-inbox",
      granteeInboxId: "agent-inbox",
      conversationId: "conv-race-bind",
      toolkit: "googlecalendar",
      bundleIds: ["calendar.events"],
    });
    const deleted: string[] = [];
    const state: StatefulStubState = {
      connections: [
        { id: "conn_a", userId: accountId, slug: "googlecalendar" },
      ],
      deleted,
    };
    state.afterListSnapshot = (call) => {
      if (call === 1) {
        // A concurrent bind's OAuth completes right after the teardown took
        // its inventory snapshot: the new credential is invisible to the
        // first pass.
        state.connections.push({
          id: "conn_new",
          userId: accountId,
          slug: "googlecalendar",
        });
      }
    };
    installStatefulComposioStub(state);

    const res = await request(makeApp())
      .delete("/abilities/googlecalendar/entitlement")
      .set("X-Convos-AuthToken", await token(accountId));
    expect(res.status).toBe(204);
    // The post-tombstone re-list caught the credential the snapshot missed.
    expect(deleted).toEqual(["conn_a", "conn_new"]);

    const row = await prisma.abilityEntitlement.findUnique({
      where: {
        accountId_abilityId: { accountId, abilityId: "googlecalendar" },
      },
      include: { extensions: true },
    });
    expect(row!.status).toBe("revoked");
    expect(row!.extensions).toHaveLength(0);
  });

  test("external teardown succeeded but the transaction failed: the retried DELETE converges", async () => {
    const accountId = await makeAccount();
    await issueConnectionGrant({
      accountId,
      ownerInboxId: "owner-inbox",
      granteeInboxId: "agent-inbox",
      conversationId: "conv-partial-failure",
      toolkit: "googlecalendar",
      bundleIds: ["calendar.events"],
    });
    const deleted: string[] = [];
    installStatefulComposioStub({
      connections: [
        { id: "conn_a", userId: accountId, slug: "googlecalendar" },
      ],
      deleted,
    });

    // Manual patch, not vi.spyOn — see the pattern note in tests/abilities.test.ts.
    const client = prisma as unknown as {
      $transaction: (...args: never[]) => Promise<unknown>;
    };
    const original = client.$transaction.bind(prisma);
    client.$transaction = () =>
      Promise.reject(new Error("induced transaction failure"));
    let first;
    try {
      first = await request(makeApp())
        .delete("/abilities/googlecalendar/entitlement")
        .set("X-Convos-AuthToken", await token(accountId));
    } finally {
      client.$transaction = original;
    }

    // The divergent window the teardown-first ordering accepts: the external
    // credential is gone while the local row is still active. The row is not
    // tombstoned over a credential whose deletion DID happen — the caller
    // got a 5xx and retries.
    expect(first.status).toBe(500);
    expect(deleted).toEqual(["conn_a"]);
    const mid = await prisma.abilityEntitlement.findUnique({
      where: {
        accountId_abilityId: { accountId, abilityId: "googlecalendar" },
      },
    });
    expect(mid!.status).toBe("active");
    expect(mid!.revokedAt).toBeNull();

    // The retry converges: nothing external left to delete, local teardown
    // lands, tombstone kept.
    const retry = await request(makeApp())
      .delete("/abilities/googlecalendar/entitlement")
      .set("X-Convos-AuthToken", await token(accountId));
    expect(retry.status).toBe(204);
    expect(deleted).toEqual(["conn_a"]);
    const row = await prisma.abilityEntitlement.findUnique({
      where: {
        accountId_abilityId: { accountId, abilityId: "googlecalendar" },
      },
      include: { extensions: true },
    });
    expect(row!.status).toBe("revoked");
    expect(row!.revokedAt).not.toBeNull();
    expect(row!.extensions).toHaveLength(0);

    const grants = await prisma.connectionGrant.findMany({
      where: { ownerAccountId: accountId },
    });
    expect(grants.every((g) => g.revokedAt !== null)).toBe(true);
  });
});
