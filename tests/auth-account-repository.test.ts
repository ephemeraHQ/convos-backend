import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { upsertAuthMethodAndAccount } from "@/accounts/repository";
import { ADMIN_ACCOUNT_ID } from "@/utils/constants";
import { prisma } from "@/utils/prisma";

const ADDR_A = "0x" + "a".repeat(40);
const ADDR_B = "0x" + "b".repeat(40);

// Preserve the admin account seeded by migration; only wipe rows created by tests.
const nonAdminAccountFilter = { id: { not: ADMIN_ACCOUNT_ID } };

async function reset() {
  await prisma.authMethod.deleteMany();
  // CreditLedger + UserCredits hang off Account via FK. Wipe them first so
  // the subsequent Account.deleteMany() doesn't trip UserCredits_accountId_fkey
  // when prior tests in the run left credit rows behind.
  await prisma.creditLedger.deleteMany();
  await prisma.userCredits.deleteMany();
  await prisma.account.deleteMany({ where: nonAdminAccountFilter });
}

describe("upsertAuthMethodAndAccount", () => {
  beforeAll(reset);
  afterEach(reset);

  test("first login: creates Account + AuthMethod, returns accountId", async () => {
    const { accountId } = await upsertAuthMethodAndAccount({
      type: "SIWE",
      externalKey: ADDR_A,
    });
    const account = await prisma.account.findUnique({
      where: { id: accountId },
    });
    expect(account).not.toBeNull();
    const method = await prisma.authMethod.findFirst({
      where: { accountId, type: "SIWE" },
    });
    expect(method?.externalKey).toBe(ADDR_A);
  });

  test("second login same wallet: returns same accountId, does not insert", async () => {
    const first = await upsertAuthMethodAndAccount({
      type: "SIWE",
      externalKey: ADDR_A,
    });
    const second = await upsertAuthMethodAndAccount({
      type: "SIWE",
      externalKey: ADDR_A,
    });
    expect(second.accountId).toBe(first.accountId);
    const accounts = await prisma.account.count({
      where: nonAdminAccountFilter,
    });
    expect(accounts).toBe(1);
    const methods = await prisma.authMethod.count();
    expect(methods).toBe(1);
  });

  test("two different wallets create two accounts", async () => {
    const a = await upsertAuthMethodAndAccount({
      type: "SIWE",
      externalKey: ADDR_A,
    });
    const b = await upsertAuthMethodAndAccount({
      type: "SIWE",
      externalKey: ADDR_B,
    });
    expect(a.accountId).not.toBe(b.accountId);
    expect(await prisma.account.count({ where: nonAdminAccountFilter })).toBe(
      2,
    );
  });

  test("concurrent first-login same wallet → both resolve to same accountId, no orphan", async () => {
    const ADDR_C = "0x" + "c".repeat(40);
    const [a, b] = await Promise.all([
      upsertAuthMethodAndAccount({
        type: "SIWE",
        externalKey: ADDR_C,
      }),
      upsertAuthMethodAndAccount({
        type: "SIWE",
        externalKey: ADDR_C,
      }),
    ]);
    expect(a.accountId).toBe(b.accountId);
    expect(await prisma.account.count({ where: nonAdminAccountFilter })).toBe(
      1,
    );
    expect(await prisma.authMethod.count()).toBe(1);
  });
});
