import express from "express";
import request from "supertest";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import { abilitiesRouter } from "@/api/v2/abilities/abilities.router";
import {
  ABILITY_MANIFESTS,
  CATALOG_VERSION,
  getCatalogVersion,
} from "@/api/v2/abilities/manifests.config";
import { getServiceConfig } from "@/api/v2/connections/bundles.config";
import {
  __resetComposioServiceForTests,
  ComposioService,
} from "@/api/v2/connections/composio.service";
import { authMiddleware } from "@/middleware/auth";
import { pinoMiddleware } from "@/middleware/pino";
import { createJwtToken, validateJWTKeys } from "@/utils/jwt";
import { prisma } from "@/utils/prisma";

vi.mock("firebase-admin/app");
vi.mock("firebase-admin/app-check");
vi.mock("firebase-admin/messaging");

// Mirrors the production wiring: JWT-only (authMiddleware), NOT requireAccount.
function makeApp() {
  const app = express();
  app.use(pinoMiddleware);
  app.use("/abilities", authMiddleware, abilitiesRouter);
  return app;
}

type AbilitiesResponse = {
  catalogVersion: number;
  entitlementsUnavailable?: true;
  abilities: Array<{
    id: string;
    version: number;
    displayName: { en: string };
    subtitle: { en: string };
    auth: { type: string };
    bundles: Array<{ id: string; defaultEnabled: boolean }>;
    entitlement?: { status: string; extensionCount: number } | null;
  }>;
};

type StubbedConnection = {
  id: string;
  status: string;
  toolkit: { slug: string };
};

function installService(stub: {
  connectedAccounts: { list: (params?: unknown) => Promise<unknown> };
}) {
  const service = new ComposioService({
    composio: stub as unknown as ConstructorParameters<
      typeof ComposioService
    >[0]["composio"],
  });
  __resetComposioServiceForTests(service);
}

// Installs a ComposioService whose connectedAccounts.list serves the given
// items (or throws), following the stub pattern in connections.test.ts.
function installListStub(items: StubbedConnection[] | Error) {
  installService({
    connectedAccounts: {
      list: () =>
        items instanceof Error
          ? Promise.reject(items)
          : Promise.resolve({ items }),
    },
  });
}

// Installs a stub whose list is cursor-paginated: each call serves the next
// page and a nextCursor until the last page. Received cursors are recorded so
// tests can pin that the pagination loop actually follows them.
function installPagedListStub(
  pages: StubbedConnection[][],
  receivedCursors: Array<string | undefined>,
) {
  let call = 0;
  installService({
    connectedAccounts: {
      list: (params?: unknown) => {
        receivedCursors.push(
          (params as { cursor?: string } | undefined)?.cursor,
        );
        const items = pages[call] ?? [];
        call++;
        return Promise.resolve({
          items,
          ...(call < pages.length ? { nextCursor: `cursor-${call}` } : {}),
        });
      },
    },
  });
}

let accountId: string;

beforeAll(async () => {
  await validateJWTKeys();
  const account = await prisma.account.create({ data: {} });
  accountId = account.id;
});

afterAll(async () => {
  __resetComposioServiceForTests(null);
  await prisma.connectionGrant.deleteMany({
    where: { ownerAccountId: accountId },
  });
  await prisma.account.delete({ where: { id: accountId } });
});

beforeEach(async () => {
  __resetComposioServiceForTests(null);
  await prisma.connectionGrant.deleteMany({
    where: { ownerAccountId: accountId },
  });
});

function accountToken() {
  return createJwtToken({ deviceId: "device-abilities", accountId });
}

describe("GET /v2/abilities", () => {
  test("401 without a JWT", async () => {
    const res = await request(makeApp()).get("/abilities");
    expect(res.status).toBe(401);
  });

  test("device-only JWT: catalog with entitlement null everywhere, no-store", async () => {
    const token = await createJwtToken({ deviceId: "device-abilities" });
    const res = await request(makeApp())
      .get("/abilities")
      .set("X-Convos-AuthToken", token);
    expect(res.status).toBe(200);
    // Same URL serves account state after sign-in; never cache either body.
    expect(res.headers["cache-control"]).toBe("no-store");

    const body = res.body as AbilitiesResponse;
    // Computed: base + sum of served ability versions, so a plain constant
    // serve would fail the greater-than pin.
    expect(body.catalogVersion).toBe(getCatalogVersion());
    expect(body.catalogVersion).toBeGreaterThan(CATALOG_VERSION);
    expect("entitlementsUnavailable" in body).toBe(false);
    expect(body.abilities.length).toBeGreaterThan(0);
    for (const ability of body.abilities) {
      expect(ability.entitlement).toBeNull();
    }

    const gcal = body.abilities.find((a) => a.id === "googlecalendar");
    expect(gcal).toBeDefined();
    expect(gcal!.displayName.en).toBe("Google Calendar");
    expect(typeof gcal!.subtitle.en).toBe("string");
    expect(gcal!.auth.type).toBe("oauth");
    // Bundles come from the shared service catalog: live ones only.
    expect(gcal!.bundles.map((b) => b.id)).toEqual(["calendar.events"]);
  });

  test("served version is manifest version + linked service version", async () => {
    const token = await createJwtToken({ deviceId: "device-abilities" });
    const res = await request(makeApp())
      .get("/abilities")
      .set("X-Convos-AuthToken", token);
    const body = res.body as AbilitiesResponse;
    const gcal = body.abilities.find((a) => a.id === "googlecalendar");
    const manifest = ABILITY_MANIFESTS.find((m) => m.id === "googlecalendar");
    const svc = getServiceConfig("googlecalendar");
    expect(manifest).toBeDefined();
    expect(svc).toBeDefined();
    expect(gcal!.version).toBe(manifest!.version + svc!.version);
  });

  test("hidden manifests are not served", async () => {
    const token = await createJwtToken({ deviceId: "device-abilities" });
    const res = await request(makeApp())
      .get("/abilities")
      .set("X-Convos-AuthToken", token);
    const body = res.body as AbilitiesResponse;
    const ids = body.abilities.map((a) => a.id);
    for (const hidden of [
      "coinbase",
      "shopify",
      "spotify",
      "youtube",
      "gmail",
    ]) {
      expect(ids).not.toContain(hidden);
    }
  });

  test("no Composio action slug, connection id, or deprecated bundle leaks", async () => {
    installListStub([
      { id: "conn-1", status: "ACTIVE", toolkit: { slug: "googlecalendar" } },
    ]);
    const res = await request(makeApp())
      .get("/abilities")
      .set("X-Convos-AuthToken", await accountToken());
    expect(res.status).toBe(200);
    const payload = JSON.stringify(res.body);
    expect(payload).not.toMatch(/GOOGLECALENDAR_/);
    expect(payload).not.toMatch(/composioActions/);
    // The Composio connection id is a bearer capability and stays backend-side.
    expect(payload).not.toContain("conn-1");
    // Deprecated bundles are grant-resolvable but never served (mirrors the
    // connections-services pin).
    expect(payload).not.toContain("calendar.events.read");
    expect(payload).not.toContain("deprecated");
  });

  test("account JWT + ACTIVE connection + grants: active with distinct conversation count", async () => {
    installListStub([
      { id: "conn-1", status: "ACTIVE", toolkit: { slug: "googlecalendar" } },
    ]);
    const base = {
      ownerAccountId: accountId,
      ownerInboxId: "inbox-owner",
      granteeInboxId: "inbox-agent",
      toolkit: "googlecalendar",
      bundleIds: ["calendar.events"],
    };
    await prisma.connectionGrant.createMany({
      data: [
        { ...base, conversationId: "conv-b" },
        { ...base, conversationId: "conv-a" },
        // A second agent in the same conversation: one conversation counted.
        { ...base, conversationId: "conv-a", granteeInboxId: "inbox-agent-2" },
      ],
    });

    const res = await request(makeApp())
      .get("/abilities")
      .set("X-Convos-AuthToken", await accountToken());
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");

    const body = res.body as AbilitiesResponse;
    const gcal = body.abilities.find((a) => a.id === "googlecalendar");
    expect(gcal!.entitlement).toEqual({
      status: "active",
      extensionCount: 2,
    });
  });

  test("revoked and expired grants do not count; future expiry does", async () => {
    installListStub([
      { id: "conn-1", status: "ACTIVE", toolkit: { slug: "googlecalendar" } },
    ]);
    const base = {
      ownerAccountId: accountId,
      ownerInboxId: "inbox-owner",
      granteeInboxId: "inbox-agent",
      toolkit: "googlecalendar",
      bundleIds: ["calendar.events"],
    };
    await prisma.connectionGrant.createMany({
      data: [
        { ...base, conversationId: "conv-revoked", revokedAt: new Date() },
        // Expired grants are dead to exec, so the catalog must not count them.
        {
          ...base,
          conversationId: "conv-expired",
          expiresAt: new Date(Date.now() - 60_000),
        },
        {
          ...base,
          conversationId: "conv-live",
          expiresAt: new Date(Date.now() + 60_000),
        },
      ],
    });

    const res = await request(makeApp())
      .get("/abilities")
      .set("X-Convos-AuthToken", await accountToken());
    const body = res.body as AbilitiesResponse;
    const gcal = body.abilities.find((a) => a.id === "googlecalendar");
    expect(gcal!.entitlement).toEqual({
      status: "active",
      extensionCount: 1,
    });
  });

  // The full SDK status union (INITIALIZING | INITIATED | ACTIVE | FAILED |
  // EXPIRED | INACTIVE | REVOKED) plus a value outside it. The V1 adapter
  // emits only pending_auth/active/expired; needs_reauth is B2-reserved.
  test.each([
    ["INITIALIZING", "pending_auth"],
    ["INITIATED", "pending_auth"],
    ["ACTIVE", "active"],
    ["FAILED", "expired"],
    ["EXPIRED", "expired"],
    ["INACTIVE", "expired"],
    ["REVOKED", "expired"],
    ["SOME_FUTURE_STATUS", "expired"],
  ])("Composio status %s maps to %s", async (composioStatus, wireStatus) => {
    installListStub([
      {
        id: "conn-1",
        status: composioStatus,
        toolkit: { slug: "googlecalendar" },
      },
    ]);
    const res = await request(makeApp())
      .get("/abilities")
      .set("X-Convos-AuthToken", await accountToken());
    const gcal = (res.body as AbilitiesResponse).abilities.find(
      (a) => a.id === "googlecalendar",
    );
    expect(gcal!.entitlement!.status).toBe(wireStatus);
  });

  test("most usable connection wins regardless of list order", async () => {
    // Worse then better: catches an inverted rank comparison.
    installListStub([
      { id: "conn-1", status: "EXPIRED", toolkit: { slug: "googlecalendar" } },
      { id: "conn-2", status: "ACTIVE", toolkit: { slug: "googlecalendar" } },
    ]);
    let res = await request(makeApp())
      .get("/abilities")
      .set("X-Convos-AuthToken", await accountToken());
    let gcal = (res.body as AbilitiesResponse).abilities.find(
      (a) => a.id === "googlecalendar",
    );
    expect(gcal!.entitlement!.status).toBe("active");

    // Better then worse: catches an unconditional overwrite of the rank.
    installListStub([
      { id: "conn-1", status: "ACTIVE", toolkit: { slug: "googlecalendar" } },
      { id: "conn-2", status: "EXPIRED", toolkit: { slug: "googlecalendar" } },
    ]);
    res = await request(makeApp())
      .get("/abilities")
      .set("X-Convos-AuthToken", await accountToken());
    gcal = (res.body as AbilitiesResponse).abilities.find(
      (a) => a.id === "googlecalendar",
    );
    expect(gcal!.entitlement!.status).toBe("active");
  });

  test("connections past the first Composio page are seen", async () => {
    const receivedCursors: Array<string | undefined> = [];
    installPagedListStub(
      [
        [{ id: "conn-1", status: "EXPIRED", toolkit: { slug: "spotify" } }],
        [
          {
            id: "conn-2",
            status: "ACTIVE",
            toolkit: { slug: "googlecalendar" },
          },
        ],
      ],
      receivedCursors,
    );
    const res = await request(makeApp())
      .get("/abilities")
      .set("X-Convos-AuthToken", await accountToken());
    expect(res.status).toBe(200);
    expect(receivedCursors).toEqual([undefined, "cursor-1"]);
    const gcal = (res.body as AbilitiesResponse).abilities.find(
      (a) => a.id === "googlecalendar",
    );
    expect(gcal!.entitlement!.status).toBe("active");
  });

  test("Composio page-bound hit: truncated state is not served as authoritative", async () => {
    const receivedCursors: Array<string | undefined> = [];
    // One more page than the service's bound: every call advertises a next
    // cursor, so the loop hits the cap and must refuse the partial result.
    const pages: StubbedConnection[][] = Array.from({ length: 11 }, (_, i) => [
      {
        id: `conn-${i}`,
        status: "ACTIVE",
        toolkit: { slug: "googlecalendar" },
      },
    ]);
    installPagedListStub(pages, receivedCursors);
    const res = await request(makeApp())
      .get("/abilities")
      .set("X-Convos-AuthToken", await accountToken());
    expect(res.status).toBe(200);
    expect(receivedCursors).toHaveLength(10);
    const body = res.body as AbilitiesResponse;
    expect(body.entitlementsUnavailable).toBe(true);
    for (const ability of body.abilities) {
      expect("entitlement" in ability).toBe(false);
    }
  });

  test("connections outside the catalog do not add abilities", async () => {
    installListStub([
      { id: "conn-1", status: "ACTIVE", toolkit: { slug: "googledrive" } },
    ]);
    const res = await request(makeApp())
      .get("/abilities")
      .set("X-Convos-AuthToken", await accountToken());
    const body = res.body as AbilitiesResponse;
    expect(body.abilities.map((a) => a.id)).not.toContain("googledrive");
    const gcal = body.abilities.find((a) => a.id === "googlecalendar");
    expect(gcal!.entitlement).toBeNull();
  });

  test("Composio outage: entitlementsUnavailable, no entitlement keys, catalog served", async () => {
    installListStub(new Error("composio down"));
    const res = await request(makeApp())
      .get("/abilities")
      .set("X-Convos-AuthToken", await accountToken());
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const body = res.body as AbilitiesResponse;
    expect(body.entitlementsUnavailable).toBe(true);
    expect(body.abilities.length).toBeGreaterThan(0);
    for (const ability of body.abilities) {
      expect("entitlement" in ability).toBe(false);
    }
  });
});
