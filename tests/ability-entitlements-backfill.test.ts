import type { Composio } from "@composio/core";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  backfillAbilityEntitlements,
  listAllConnectedAccounts,
  type ConnectedAccountSummary,
} from "@/api/v2/abilities/backfill-entitlements";
import { getServedAbilityVersion } from "@/api/v2/abilities/manifests.config";
import logger from "@/utils/logger";
import { prisma } from "@/utils/prisma";

vi.mock("firebase-admin/app");
vi.mock("firebase-admin/app-check");
vi.mock("firebase-admin/messaging");

// DB-backed suite (pnpm test:local / shared local Postgres). Seeds the LEGACY
// stores directly — ConnectionGrant rows and a stubbed Composio inventory are
// exactly what the backfill consumes in production.

const accountIds: string[] = [];

async function makeAccount(): Promise<string> {
  const account = await prisma.account.create({ data: {} });
  accountIds.push(account.id);
  return account.id;
}

async function* fromArray(
  items: ConnectedAccountSummary[],
): AsyncGenerator<ConnectedAccountSummary> {
  for (const item of items) {
    yield await Promise.resolve(item);
  }
}

function run(items: ConnectedAccountSummary[]) {
  return backfillAbilityEntitlements({
    log: logger,
    source: fromArray(items),
  });
}

afterEach(async () => {
  // AbilityEntitlement cascade removes ConversationAbility rows.
  await prisma.abilityEntitlement.deleteMany({
    where: { accountId: { in: accountIds } },
  });
  await prisma.connectionGrant.deleteMany({
    where: { ownerAccountId: { in: accountIds } },
  });
  await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
  accountIds.length = 0;
});

describe("backfillAbilityEntitlements — entitlement sources (DB)", () => {
  test("connected-but-never-granted accounts get an entitlement (union, no drop)", async () => {
    const accountId = await makeAccount();
    const counts = await run([
      {
        id: "conn-never-granted",
        userId: accountId,
        // Mixed case in, canonical lowercase ability id out.
        toolkitSlug: "GOOGLECALENDAR",
        status: "ACTIVE",
      },
    ]);

    const row = await prisma.abilityEntitlement.findUnique({
      where: {
        accountId_abilityId: { accountId, abilityId: "googlecalendar" },
      },
      include: { extensions: true },
    });
    expect(row).not.toBeNull();
    expect(row!.status).toBe("active");
    expect(row!.externalConnectionId).toBe("conn-never-granted");
    expect(row!.abilityVersion).toBe(getServedAbilityVersion("googlecalendar"));
    expect(row!.extensions).toHaveLength(0);
    expect(counts.entitlementsCreated).toBeGreaterThanOrEqual(1);
  });

  test("granted-but-credential-gone maps to an expired entitlement + 1:1 extension", async () => {
    const accountId = await makeAccount();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    const grant = await prisma.connectionGrant.create({
      data: {
        ownerAccountId: accountId,
        ownerInboxId: "owner-inbox-bf",
        granteeInboxId: "agent-inbox-bf",
        conversationId: "conv-bf-1",
        toolkit: "googlecalendar",
        actions: ["GOOGLECALENDAR_EVENTS_LIST"],
        bundleIds: ["calendar.events"],
        expiresAt,
      },
    });

    await run([]);

    const entitlement = await prisma.abilityEntitlement.findUnique({
      where: {
        accountId_abilityId: { accountId, abilityId: "googlecalendar" },
      },
      include: { extensions: true },
    });
    expect(entitlement).not.toBeNull();
    expect(entitlement!.status).toBe("expired");
    expect(entitlement!.externalConnectionId).toBeNull();

    // The extension is the grant, reshaped: same id, same createdAt, the
    // grantee becomes the agent, the owner inbox becomes the extender, and
    // both scope fields (bundleIds + legacy actions) carry over verbatim.
    expect(entitlement!.extensions).toHaveLength(1);
    const extension = entitlement!.extensions[0];
    expect(extension.id).toBe(grant.id);
    expect(extension.createdAt).toEqual(grant.createdAt);
    expect(extension.conversationId).toBe("conv-bf-1");
    expect(extension.agentInboxId).toBe("agent-inbox-bf");
    expect(extension.extendedByInboxId).toBe("owner-inbox-bf");
    expect(extension.bundleIds).toEqual(["calendar.events"]);
    expect(extension.actions).toEqual(["GOOGLECALENDAR_EVENTS_LIST"]);
    expect(extension.expiresAt).toEqual(expiresAt);
  });

  test("revoked and expired grants are not carried (dead to exec, dead here)", async () => {
    const accountId = await makeAccount();
    const base = {
      ownerAccountId: accountId,
      ownerInboxId: "owner-inbox-bf",
      granteeInboxId: "agent-inbox-bf",
      toolkit: "googlecalendar",
    };
    await prisma.connectionGrant.create({
      data: { ...base, conversationId: "conv-revoked", revokedAt: new Date() },
    });
    await prisma.connectionGrant.create({
      data: {
        ...base,
        conversationId: "conv-expired",
        expiresAt: new Date(Date.now() - 60_000),
      },
    });

    await run([]);

    // Neither grant is live, and there is no connection either: no
    // entitlement, no extensions.
    const entitlement = await prisma.abilityEntitlement.findUnique({
      where: {
        accountId_abilityId: { accountId, abilityId: "googlecalendar" },
      },
    });
    expect(entitlement).toBeNull();
  });

  test("multi-credential: the most usable connection wins, in either order", async () => {
    const accountId = await makeAccount();
    await run([
      {
        id: "c-exp",
        userId: accountId,
        toolkitSlug: "googlecalendar",
        status: "EXPIRED",
      },
      {
        id: "c-act",
        userId: accountId,
        toolkitSlug: "googlecalendar",
        status: "ACTIVE",
      },
    ]);
    let row = await prisma.abilityEntitlement.findUnique({
      where: {
        accountId_abilityId: { accountId, abilityId: "googlecalendar" },
      },
    });
    expect(row!.status).toBe("active");
    expect(row!.externalConnectionId).toBe("c-act");

    // Reversed order must not overwrite the better-ranked candidate.
    const accountId2 = await makeAccount();
    await run([
      {
        id: "c-act2",
        userId: accountId2,
        toolkitSlug: "googlecalendar",
        status: "ACTIVE",
      },
      {
        id: "c-exp2",
        userId: accountId2,
        toolkitSlug: "googlecalendar",
        status: "EXPIRED",
      },
    ]);
    row = await prisma.abilityEntitlement.findUnique({
      where: {
        accountId_abilityId: {
          accountId: accountId2,
          abilityId: "googlecalendar",
        },
      },
    });
    expect(row!.status).toBe("active");
    expect(row!.externalConnectionId).toBe("c-act2");
  });

  test.each([
    ["INITIALIZING", "pending_auth"],
    ["INITIATED", "pending_auth"],
    ["ACTIVE", "active"],
    ["FAILED", "expired"],
    ["EXPIRED", "expired"],
    ["INACTIVE", "expired"],
    ["REVOKED", "expired"],
    ["SOME_FUTURE_STATUS", "expired"],
  ])("Composio status %s backfills as %s", async (composioStatus, expected) => {
    const accountId = await makeAccount();
    await run([
      {
        id: "conn-map",
        userId: accountId,
        toolkitSlug: "googlecalendar",
        status: composioStatus,
      },
    ]);
    const row = await prisma.abilityEntitlement.findUnique({
      where: {
        accountId_abilityId: { accountId, abilityId: "googlecalendar" },
      },
    });
    expect(row!.status).toBe(expected);
  });

  test("orphan connections (unknown account) are skipped, not written", async () => {
    const strangerId = "11111111-1111-4111-8111-111111111111";
    const counts = await run([
      {
        id: "conn-orphan",
        userId: strangerId,
        toolkitSlug: "googlecalendar",
        status: "ACTIVE",
      },
    ]);
    expect(counts.connectionsOrphaned).toBe(1);
    const rows = await prisma.abilityEntitlement.findMany({
      where: { accountId: strangerId },
    });
    expect(rows).toHaveLength(0);
  });
});

describe("backfillAbilityEntitlements — convergence rules (DB)", () => {
  test("revoked entitlements are never resurrected, and their grants are skipped", async () => {
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
    // A live grant AND an active connection both point at the tombstone; the
    // pass must touch neither the status nor create the extension.
    await prisma.connectionGrant.create({
      data: {
        ownerAccountId: accountId,
        ownerInboxId: "owner-inbox-bf",
        granteeInboxId: "agent-inbox-bf",
        conversationId: "conv-bf-revoked",
        toolkit: "googlecalendar",
      },
    });
    const counts = await run([
      {
        id: "conn-stale",
        userId: accountId,
        toolkitSlug: "googlecalendar",
        status: "ACTIVE",
      },
    ]);

    const row = await prisma.abilityEntitlement.findUnique({
      where: {
        accountId_abilityId: { accountId, abilityId: "googlecalendar" },
      },
      include: { extensions: true },
    });
    expect(row!.status).toBe("revoked");
    expect(row!.revokedAt).toEqual(revokedAt);
    expect(row!.externalConnectionId).toBeNull();
    expect(row!.extensions).toHaveLength(0);
    expect(counts.entitlementsSkippedRevoked).toBeGreaterThanOrEqual(1);
    expect(counts.grantsSkippedRevokedEntitlement).toBeGreaterThanOrEqual(1);
  });

  test("re-running refreshes status from Composio and is idempotent", async () => {
    const accountId = await makeAccount();
    await prisma.connectionGrant.create({
      data: {
        ownerAccountId: accountId,
        ownerInboxId: "owner-inbox-bf",
        granteeInboxId: "agent-inbox-bf",
        conversationId: "conv-bf-2",
        toolkit: "googlecalendar",
        bundleIds: ["calendar.events"],
      },
    });

    await run([
      {
        id: "conn-1",
        userId: accountId,
        toolkitSlug: "googlecalendar",
        status: "ACTIVE",
      },
    ]);
    const first = await prisma.abilityEntitlement.findUnique({
      where: {
        accountId_abilityId: { accountId, abilityId: "googlecalendar" },
      },
      include: { extensions: true },
    });
    expect(first!.status).toBe("active");
    expect(first!.extensions).toHaveLength(1);
    const extensionId = first!.extensions[0].id;

    // Same input again: nothing new created, the extension keeps its id.
    const again = await run([
      {
        id: "conn-1",
        userId: accountId,
        toolkitSlug: "googlecalendar",
        status: "ACTIVE",
      },
    ]);
    expect(again.entitlementsCreated).toBe(0);
    const second = await prisma.abilityEntitlement.findUnique({
      where: {
        accountId_abilityId: { accountId, abilityId: "googlecalendar" },
      },
      include: { extensions: true },
    });
    expect(second!.id).toBe(first!.id);
    expect(second!.extensions).toHaveLength(1);
    expect(second!.extensions[0].id).toBe(extensionId);

    // The reconciliation sweep reflects upstream drift: the credential died.
    await run([
      {
        id: "conn-1",
        userId: accountId,
        toolkitSlug: "googlecalendar",
        status: "EXPIRED",
      },
    ]);
    const third = await prisma.abilityEntitlement.findUnique({
      where: {
        accountId_abilityId: { accountId, abilityId: "googlecalendar" },
      },
    });
    expect(third!.status).toBe("expired");
  });
});

describe("listAllConnectedAccounts (no DB)", () => {
  test("follows Composio cursors across every page", async () => {
    const receivedCursors: Array<string | null> = [];
    const pages = [
      {
        items: [
          {
            id: "c1",
            user_id: "acct-1",
            toolkit: { slug: "googlecalendar" },
            status: "ACTIVE",
          },
        ],
        next_cursor: "cursor-1",
      },
      {
        items: [
          {
            id: "c2",
            user_id: "acct-2",
            toolkit: { slug: "spotify" },
            status: "EXPIRED",
          },
        ],
        next_cursor: null,
      },
    ];
    let call = 0;
    const client = {
      connectedAccounts: {
        list: (params: { cursor: string | null }) => {
          receivedCursors.push(params.cursor);
          return Promise.resolve(pages[call++]);
        },
      },
    } as unknown as ReturnType<Composio["getClient"]>;

    const seen: string[] = [];
    for await (const item of listAllConnectedAccounts(client)) {
      seen.push(`${item.id}:${item.userId}:${item.toolkitSlug}:${item.status}`);
    }
    expect(seen).toEqual([
      "c1:acct-1:googlecalendar:ACTIVE",
      "c2:acct-2:spotify:EXPIRED",
    ]);
    expect(receivedCursors).toEqual([null, "cursor-1"]);
  });
});
