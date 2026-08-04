import { randomUUID } from "node:crypto";
import { BillingProvider } from "@prisma/client";
import { afterEach, describe, expect, test } from "vitest";
import { grant } from "@/payments";
import { deleteWalletForAccountWithTx } from "@/payments/ledger";
import {
  CUSTODY_STATE_ESCROW,
  CUSTODY_STATE_HELD,
  escrowCustody,
  EscrowWalletMissingError,
  findCustodyCovering,
} from "@/subscriptions/custody";
import { lockLineage } from "@/subscriptions/lineage";
import { prisma } from "@/utils/prisma";

/**
 * The deletion teardown must settle escrow BEFORE deleteWalletForAccountWithTx.
 * Run the other way round, computeMoveAmount's balance lock would silently
 * upsert a fresh zero wallet: escrow conserves 0 and the recreated
 * UserCredits row breaks the Account delete on its RESTRICT FK. The guard in
 * escrowCustody turns that silent mis-ordering into a loud failure.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

const wipe = async () => {
  await prisma.subscriptionTransfer.deleteMany();
  await prisma.lineagePeriodCustody.deleteMany();
  await prisma.subscriptionLineage.deleteMany();
  await prisma.creditLedger.deleteMany();
  await prisma.userCredits.deleteMany();
  await prisma.account.deleteMany({
    where: { id: { not: "48a05ef4-4a71-57a0-957f-a3d410992b31" } },
  });
};

afterEach(wipe);

/** Account with a 500-credit wallet holding a 2500-cap custody period. */
const buildHeldCustody = async () => {
  const account = await prisma.account.create({ data: {} });
  await grant({
    accountId: account.id,
    credits: 500,
    kind: "manual",
    idempotencyKey: `test_grant_${account.id}`,
    note: "escrow-order fixture",
  });
  const lineage = await prisma.subscriptionLineage.create({
    data: {
      provider: BillingProvider.apple,
      lineageKey: `otx-${account.id.slice(0, 8)}`,
    },
  });
  await prisma.lineagePeriodCustody.create({
    data: {
      lineageId: lineage.id,
      providerPeriodKey: `period-${randomUUID().slice(0, 8)}`,
      ownerAccountId: account.id,
      remainderCap: 2500n,
      custodyStartedAt: new Date(),
      periodStart: new Date(Date.now() - DAY_MS),
      periodEnd: new Date(Date.now() + DAY_MS),
      state: CUSTODY_STATE_HELD,
    },
  });
  return { accountId: account.id, lineageId: lineage.id };
};

describe("escrow-before-wallet-teardown guard", () => {
  test("escrow after the wallet teardown fails loudly and rolls back", async () => {
    const { accountId, lineageId } = await buildHeldCustody();

    await expect(
      prisma.$transaction(async (tx) => {
        const ctx = await lockLineage(tx, lineageId);
        // WRONG order: wallet teardown before escrow settlement.
        await deleteWalletForAccountWithTx(tx, accountId);
        const custody = await findCustodyCovering(tx, ctx, new Date(), [
          CUSTODY_STATE_HELD,
        ]);
        if (!custody) throw new Error("fixture: custody row missing");
        await escrowCustody(tx, ctx, { custody, journalId: randomUUID() });
      }),
    ).rejects.toBeInstanceOf(EscrowWalletMissingError);

    // The transaction rolled back: the wallet survives with its balance,
    // custody stays held — nothing was silently conserved as zero and no
    // ghost zero-balance UserCredits row was upserted.
    const wallet = await prisma.userCredits.findUnique({
      where: { accountId },
    });
    expect(wallet?.balance).toBe(500n);
    const custody = await prisma.lineagePeriodCustody.findFirst({
      where: { lineageId },
    });
    expect(custody?.state).toBe(CUSTODY_STATE_HELD);
    expect(custody?.remainderCap).toBe(2500n);
    expect(custody?.ownerAccountId).toBe(accountId);
  });

  test("the correct order (escrow, then wallet teardown) settles normally", async () => {
    const { accountId, lineageId } = await buildHeldCustody();

    const escrowed = await prisma.$transaction(async (tx) => {
      const ctx = await lockLineage(tx, lineageId);
      const custody = await findCustodyCovering(tx, ctx, new Date(), [
        CUSTODY_STATE_HELD,
      ]);
      if (!custody) throw new Error("fixture: custody row missing");
      const amount = await escrowCustody(tx, ctx, {
        custody,
        journalId: randomUUID(),
      });
      await deleteWalletForAccountWithTx(tx, accountId);
      return amount;
    });

    // min(balance 500, cap 2500) = 500 conserved into escrow.
    expect(escrowed).toBe(500n);
    const custody = await prisma.lineagePeriodCustody.findFirst({
      where: { lineageId },
    });
    expect(custody?.state).toBe(CUSTODY_STATE_ESCROW);
    expect(custody?.remainderCap).toBe(500n);
    expect(custody?.ownerAccountId).toBeNull();
    expect(await prisma.userCredits.count({ where: { accountId } })).toBe(0);
  });
});
