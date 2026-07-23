import { afterEach, describe, expect, test, vi } from "vitest";
import { checkEntitlement } from "@/api/v2/abilities/check-entitlement";
import logger from "@/utils/logger";
import { prisma } from "@/utils/prisma";

vi.mock("firebase-admin/app");
vi.mock("firebase-admin/app-check");
vi.mock("firebase-admin/messaging");

// The conversation path is covered end-to-end by tests/composio-exec.test.ts
// (its consumer). This file pins the proven-account path, which has no HTTP
// consumer yet (the future MCP gateway) but is part of the frozen denial
// contract.

const accountIds: string[] = [];

async function makeAccount(): Promise<string> {
  const account = await prisma.account.create({ data: {} });
  accountIds.push(account.id);
  return account.id;
}

afterEach(async () => {
  // Account delete cascades entitlements and extensions.
  await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
  accountIds.length = 0;
});

function checkAccount(
  accountId: string,
  overrides: { abilityId?: string; action?: string } = {},
) {
  return checkEntitlement({
    caller: { kind: "account", accountId },
    abilityId: overrides.abilityId ?? "googlecalendar",
    action: overrides.action,
    catalog: null,
    log: logger,
  });
}

describe("checkEntitlement — account path (DB)", () => {
  test("unknown ability is unknown_ability, not no_grant", async () => {
    const accountId = await makeAccount();
    const result = await checkAccount(accountId, {
      abilityId: "notarealability",
    });
    expect(result).toEqual({ allowed: false, code: "unknown_ability" });
  });

  test("no entitlement row is no_grant", async () => {
    const accountId = await makeAccount();
    const result = await checkAccount(accountId);
    expect(result).toEqual({ allowed: false, code: "no_grant" });
  });

  test("a revoked tombstone is no_grant, not needs_reauth", async () => {
    const accountId = await makeAccount();
    await prisma.abilityEntitlement.create({
      data: {
        accountId,
        abilityId: "googlecalendar",
        status: "revoked",
        revokedAt: new Date(),
      },
    });
    const result = await checkAccount(accountId);
    expect(result).toEqual({ allowed: false, code: "no_grant" });
  });

  test.each(["pending_auth", "needs_reauth", "expired"])(
    "a non-active entitlement (%s) is needs_reauth",
    async (status) => {
      const accountId = await makeAccount();
      await prisma.abilityEntitlement.create({
        data: { accountId, abilityId: "googlecalendar", status },
      });
      const result = await checkAccount(accountId);
      expect(result).toEqual({ allowed: false, code: "needs_reauth" });
    },
  );

  test("an active entitlement allows, with the ability's full bundle-resolved action set", async () => {
    const accountId = await makeAccount();
    const entitlement = await prisma.abilityEntitlement.create({
      data: { accountId, abilityId: "googlecalendar", status: "active" },
    });
    const result = await checkEntitlement({
      caller: { kind: "account", accountId },
      abilityId: "GoogleCalendar", // V2 surface: case-insensitive ability id
      catalog: null,
      log: logger,
    });
    expect(result.allowed).toBe(true);
    if (result.allowed) {
      expect(result.ownerAccountId).toBe(accountId);
      expect(result.entitlementId).toBe(entitlement.id);
      // Live + deprecated bundles alike: account scope is the whole ability.
      expect(result.actions).toContain("GOOGLECALENDAR_EVENTS_LIST");
      expect(result.actions).toContain("GOOGLECALENDAR_CREATE_EVENT");
    }
  });

  test("an action outside the ability's bundles is no_grant (fail closed)", async () => {
    const accountId = await makeAccount();
    await prisma.abilityEntitlement.create({
      data: { accountId, abilityId: "googlecalendar", status: "active" },
    });
    const result = await checkAccount(accountId, {
      action: "GOOGLECALENDAR_CALENDARS_DELETE",
    });
    expect(result).toEqual({ allowed: false, code: "no_grant" });
  });
});
