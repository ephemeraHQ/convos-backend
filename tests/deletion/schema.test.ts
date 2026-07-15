import { randomUUID } from "node:crypto";
import { BillingProvider, type Prisma } from "@prisma/client";
import { afterEach, describe, expect, test } from "vitest";
import { prisma } from "@/utils/prisma";

async function reset() {
  await prisma.lineageTokenAlias.deleteMany();
  await prisma.subscriptionLineage.deleteMany();
  await prisma.deletionTask.deleteMany();
  await prisma.deletionRecord.deleteMany();
  await prisma.deletedIdentity.deleteMany();
}

describe("account-deletion schema", () => {
  afterEach(reset);

  test("DeletedIdentity dedupes on identityHash", async () => {
    await prisma.deletedIdentity.create({ data: { identityHash: "hash-1" } });
    await expect(
      prisma.deletedIdentity.create({ data: { identityHash: "hash-1" } }),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  test("SubscriptionLineage is unique per (provider, lineageKey)", async () => {
    await prisma.subscriptionLineage.create({
      data: { provider: BillingProvider.apple, lineageKey: "otx-1" },
    });
    await expect(
      prisma.subscriptionLineage.create({
        data: { provider: BillingProvider.apple, lineageKey: "otx-1" },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
    // The same key under the other provider is a distinct lineage.
    await expect(
      prisma.subscriptionLineage.create({
        data: { provider: BillingProvider.googlePlay, lineageKey: "otx-1" },
      }),
    ).resolves.toMatchObject({ provider: BillingProvider.googlePlay });
  });

  test("DeletionRecord defaults to purging; DeletionTask defaults to pending", async () => {
    const operationId = randomUUID();
    const record = await prisma.deletionRecord.create({
      data: { operationId, accountRef: "ref-a" },
    });
    expect(record.status).toBe("purging");
    expect(record.completedAt).toBeNull();

    const task = await prisma.deletionTask.create({
      data: {
        operationId,
        kind: "notification_installation",
        payload: { identifier: "client-1" } satisfies Prisma.InputJsonValue,
      },
    });
    expect(task.status).toBe("pending");
    expect(task.attempts).toBe(0);
    expect(task.nextAttemptAt).toBeInstanceOf(Date);
  });
});
