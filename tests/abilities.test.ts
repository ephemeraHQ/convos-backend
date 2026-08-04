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
import { __setEntitlementReadReadinessForTests } from "@/api/v2/abilities/read-readiness";
import { getServiceConfig } from "@/api/v2/connections/bundles.config";
import {
  __resetComposioServiceForTests,
  ComposioService,
} from "@/api/v2/connections/composio.service";
import {
  issueConnectionGrant,
  revokeConnectionGrantsByNaturalKey,
} from "@/api/v2/connections/v1-grant-adapter";
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

let accountId: string;

// Entitlement state is seeded straight into the tables (the handler's source
// of truth). Extension counts are seeded through the V1-adapter path where a
// V1 grant is the natural fixture, and directly where V2 state is meant.
function seedEntitlement(
  status: string,
  overrides: {
    abilityId?: string;
    externalConnectionId?: string;
    revokedAt?: Date;
  } = {},
) {
  return prisma.abilityEntitlement.create({
    data: {
      accountId,
      abilityId: overrides.abilityId ?? "googlecalendar",
      status,
      externalConnectionId: overrides.externalConnectionId ?? null,
      revokedAt: overrides.revokedAt ?? null,
    },
  });
}

function seedGrant(overrides: {
  conversationId: string;
  granteeInboxId?: string;
  expiresAt?: Date;
}) {
  return issueConnectionGrant({
    accountId,
    ownerInboxId: "inbox-owner",
    granteeInboxId: overrides.granteeInboxId ?? "inbox-agent",
    conversationId: overrides.conversationId,
    toolkit: "googlecalendar",
    bundleIds: ["calendar.events"],
    expiresAt: overrides.expiresAt ?? null,
  });
}

beforeAll(async () => {
  await validateJWTKeys();
  // Pin the catalog onto the entitlement tables: the real gate reads the
  // shared database's migration ledgers, whose state this suite must not
  // depend on. The boot-window fallback has its own test below.
  __setEntitlementReadReadinessForTests(true);
  const account = await prisma.account.create({ data: {} });
  accountId = account.id;
});

afterAll(async () => {
  __setEntitlementReadReadinessForTests(null);
  __resetComposioServiceForTests(null);
  await prisma.connectionGrant.deleteMany({
    where: { ownerAccountId: accountId },
  });
  await prisma.account.delete({ where: { id: accountId } });
});

beforeEach(async () => {
  __resetComposioServiceForTests(null);
  // Entitlement delete cascades extensions.
  await prisma.abilityEntitlement.deleteMany({ where: { accountId } });
  await prisma.connectionGrant.deleteMany({
    where: { ownerAccountId: accountId },
  });
});

function accountToken() {
  return createJwtToken({ deviceId: "device-abilities", accountId });
}

async function getAbilities(token: string) {
  const res = await request(makeApp())
    .get("/abilities")
    .set("X-Convos-AuthToken", token);
  return res;
}

describe("GET /v2/abilities", () => {
  test("401 without a JWT", async () => {
    const res = await request(makeApp()).get("/abilities");
    expect(res.status).toBe(401);
  });

  test("device-only JWT: catalog with entitlement null everywhere, no-store", async () => {
    const token = await createJwtToken({ deviceId: "device-abilities" });
    const res = await getAbilities(token);
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

  test("device-only JWT never touches the entitlement store", async () => {
    // Manual patch, not vi.spyOn: spying on the Prisma delegate corrupts the
    // client for every later query in the file even after mockRestore.
    const delegate = prisma.abilityEntitlement;
    const original = delegate.findMany.bind(delegate);
    let calls = 0;
    delegate.findMany = ((...args: Parameters<typeof original>) => {
      calls += 1;
      return original(...args);
    }) as typeof delegate.findMany;
    try {
      const token = await createJwtToken({ deviceId: "device-abilities" });
      const res = await getAbilities(token);
      expect(res.status).toBe(200);
      expect(calls).toBe(0);
    } finally {
      delegate.findMany = original;
    }
  });

  test("served version is manifest version + linked service version", async () => {
    const token = await createJwtToken({ deviceId: "device-abilities" });
    const res = await getAbilities(token);
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
    const res = await getAbilities(token);
    const body = res.body as AbilitiesResponse;
    const ids = body.abilities.map((a) => a.id);
    for (const hidden of ["coinbase", "shopify", "spotify", "youtube"]) {
      expect(ids).not.toContain(hidden);
    }
  });

  test("gmail is served with its read-only mail.read bundle", async () => {
    const token = await createJwtToken({ deviceId: "device-abilities" });
    const res = await getAbilities(token);
    const body = res.body as AbilitiesResponse;

    const gmail = body.abilities.find((a) => a.id === "gmail");
    expect(gmail).toBeDefined();
    expect(gmail!.displayName.en).toBe("Gmail");
    expect(gmail!.subtitle.en).toBe("Read and search email");
    expect(gmail!.auth.type).toBe("oauth");
    expect(gmail!.bundles.map((b) => b.id)).toEqual(["mail.read"]);
    expect(gmail!.bundles[0].defaultEnabled).toBe(true);

    // Composite version: manifest version + linked service version.
    const manifest = ABILITY_MANIFESTS.find((m) => m.id === "gmail");
    const svc = getServiceConfig("gmail");
    expect(svc).toBeDefined();
    expect(gmail!.version).toBe(manifest!.version + svc!.version);
  });

  test("a visible OAuth ability without a usable service entry is excluded, not served empty", async () => {
    // Simulates the launch-flag-before-bundles misconfiguration: visible,
    // OAuth, but no bundles.config.ts entry. It must be suppressed (its bind
    // flow could start OAuth yet the ability could never be extended).
    ABILITY_MANIFESTS.push({
      id: "halflaunched",
      version: 1,
      displayName: { en: "Half Launched" },
      subtitle: { en: "No bundles yet" },
      auth: { type: "oauth" },
    });
    try {
      const res = await getAbilities(await accountToken());
      const body = res.body as AbilitiesResponse;
      expect(body.abilities.some((a) => a.id === "halflaunched")).toBe(false);
    } finally {
      const index = ABILITY_MANIFESTS.findIndex((m) => m.id === "halflaunched");
      if (index >= 0) ABILITY_MANIFESTS.splice(index, 1);
    }
  });

  test("an entitlement for a hidden ability does not unhide it", async () => {
    await seedEntitlement("active", { abilityId: "spotify" });
    const res = await getAbilities(await accountToken());
    const body = res.body as AbilitiesResponse;
    expect(body.abilities.map((a) => a.id)).not.toContain("spotify");
  });

  test("no Composio action slug, credential id, or deprecated bundle leaks", async () => {
    await seedEntitlement("active", { externalConnectionId: "conn-1" });
    await seedGrant({ conversationId: "conv-leak" });
    const res = await getAbilities(await accountToken());
    expect(res.status).toBe(200);
    const payload = JSON.stringify(res.body);
    expect(payload).not.toMatch(/GOOGLECALENDAR_/);
    expect(payload).not.toMatch(/GMAIL_/);
    expect(payload).not.toMatch(/composioActions/);
    // The Composio connection id is a bearer capability and stays backend-side.
    expect(payload).not.toContain("conn-1");
    // Deprecated bundles are grant-resolvable but never served (mirrors the
    // connections-services pin).
    expect(payload).not.toContain("calendar.events.read");
    expect(payload).not.toContain("deprecated");
  });

  test("account JWT + V1-issued grants: active with distinct conversation count", async () => {
    // The adapter path creates the entitlement (active) with the grants.
    await seedGrant({ conversationId: "conv-b" });
    await seedGrant({ conversationId: "conv-a" });
    // A second agent in the same conversation: one conversation counted.
    await seedGrant({
      conversationId: "conv-a",
      granteeInboxId: "inbox-agent-2",
    });

    const res = await getAbilities(await accountToken());
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
    await seedGrant({ conversationId: "conv-revoked" });
    await revokeConnectionGrantsByNaturalKey({
      accountId,
      toolkit: "googlecalendar",
      conversationId: "conv-revoked",
    });
    // Expired extensions are dead to the check, so the catalog must not
    // count them.
    await seedGrant({
      conversationId: "conv-expired",
      expiresAt: new Date(Date.now() - 60_000),
    });
    await seedGrant({
      conversationId: "conv-live",
      expiresAt: new Date(Date.now() + 60_000),
    });

    const res = await getAbilities(await accountToken());
    const body = res.body as AbilitiesResponse;
    const gcal = body.abilities.find((a) => a.id === "googlecalendar");
    expect(gcal!.entitlement).toEqual({
      status: "active",
      extensionCount: 1,
    });
  });

  test("V2-written extensions count too", async () => {
    const entitlement = await seedEntitlement("active");
    for (const [conversationId, agentInboxId] of [
      ["conv-x", "agent-1"],
      ["conv-x", "agent-2"],
      ["conv-y", "agent-1"],
    ] as const) {
      await prisma.conversationAbility.create({
        data: {
          entitlementId: entitlement.id,
          conversationId,
          agentInboxId,
          bundleIds: ["calendar.events"],
        },
      });
    }
    const res = await getAbilities(await accountToken());
    const gcal = (res.body as AbilitiesResponse).abilities.find(
      (a) => a.id === "googlecalendar",
    );
    expect(gcal!.entitlement).toEqual({ status: "active", extensionCount: 2 });
  });

  // The full table vocabulary is served verbatim — the server owns status,
  // clients never derive it. A revoked tombstone reads as revoked with no
  // extensions (revocation deletes them).
  test.each(["pending_auth", "active", "needs_reauth", "expired", "revoked"])(
    "entitlement status %s is served verbatim",
    async (status) => {
      await seedEntitlement(status, {
        revokedAt: status === "revoked" ? new Date() : undefined,
      });
      const res = await getAbilities(await accountToken());
      const gcal = (res.body as AbilitiesResponse).abilities.find(
        (a) => a.id === "googlecalendar",
      );
      expect(gcal!.entitlement).toEqual({ status, extensionCount: 0 });
    },
  );

  test("case-variant rows fold onto one wire ability; most usable status wins", async () => {
    // A legacy mixed-case toolkit row next to the canonical one.
    await seedEntitlement("expired");
    await seedEntitlement("active", { abilityId: "GOOGLECALENDAR" });
    const res = await getAbilities(await accountToken());
    const body = res.body as AbilitiesResponse;
    const matches = body.abilities.filter((a) => a.id === "googlecalendar");
    expect(matches).toHaveLength(1);
    expect(matches[0].entitlement!.status).toBe("active");
  });

  test("an account with no entitlements gets entitlement null everywhere (authoritative)", async () => {
    const res = await getAbilities(await accountToken());
    const body = res.body as AbilitiesResponse;
    expect("entitlementsUnavailable" in body).toBe(false);
    for (const ability of body.abilities) {
      expect(ability.entitlement).toBeNull();
    }
  });

  test("entitlements outside the catalog do not add abilities", async () => {
    await seedEntitlement("active", { abilityId: "googledrive" });
    const res = await getAbilities(await accountToken());
    const body = res.body as AbilitiesResponse;
    expect(body.abilities.map((a) => a.id)).not.toContain("googledrive");
    const gcal = body.abilities.find((a) => a.id === "googlecalendar");
    expect(gcal!.entitlement).toBeNull();
  });

  test("the read path never calls Composio (per-request derivation is gone)", async () => {
    // A service whose list would blow up the request if the handler still
    // consulted it.
    const stub = {
      connectedAccounts: {
        list: () => {
          throw new Error("read path must not call Composio");
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
    await seedEntitlement("active");
    const res = await getAbilities(await accountToken());
    expect(res.status).toBe(200);
    const gcal = (res.body as AbilitiesResponse).abilities.find(
      (a) => a.id === "googlecalendar",
    );
    expect(gcal!.entitlement).toEqual({ status: "active", extensionCount: 0 });
  });

  test("boot window (ledgers unconfirmed): entitlementsUnavailable, never an authoritative null", async () => {
    // The row exists, but while the tables are still converging the catalog
    // must not serve authoritative state: an account the backfill has not
    // reached would read as "not connected".
    await seedEntitlement("active");
    __setEntitlementReadReadinessForTests(false);
    try {
      const res = await getAbilities(await accountToken());
      expect(res.status).toBe(200);
      const body = res.body as AbilitiesResponse;
      expect(body.entitlementsUnavailable).toBe(true);
      expect(body.abilities.length).toBeGreaterThan(0);
      for (const ability of body.abilities) {
        expect("entitlement" in ability).toBe(false);
      }
    } finally {
      __setEntitlementReadReadinessForTests(true);
    }

    // The same account is authoritative again once the ledgers confirm.
    const after = await getAbilities(await accountToken());
    const gcal = (after.body as AbilitiesResponse).abilities.find(
      (a) => a.id === "googlecalendar",
    );
    expect(gcal!.entitlement).toEqual({ status: "active", extensionCount: 0 });
  });

  test("store outage: entitlementsUnavailable, no entitlement keys, catalog served", async () => {
    // Manual patch, not vi.spyOn — see the device-only store test.
    const delegate = prisma.abilityEntitlement;
    const original = delegate.findMany.bind(delegate);
    delegate.findMany = (() =>
      Promise.reject(new Error("store down"))) as typeof delegate.findMany;
    try {
      const res = await getAbilities(await accountToken());
      expect(res.status).toBe(200);
      expect(res.headers["cache-control"]).toBe("no-store");
      const body = res.body as AbilitiesResponse;
      expect(body.entitlementsUnavailable).toBe(true);
      expect(body.abilities.length).toBeGreaterThan(0);
      for (const ability of body.abilities) {
        expect("entitlement" in ability).toBe(false);
      }
    } finally {
      delegate.findMany = original;
    }
  });
});
