import { beforeEach, describe, expect, test, vi } from "vitest";
import { releaseBatch, tryClaimBatch } from "@/api/v2/telemetry/services/dedup";
import { prisma } from "@/utils/prisma";

describe("telemetry dedup", () => {
  beforeEach(async () => {
    await prisma.telemetryBatch.deleteMany();
  });

  test("first claim wins, second is a duplicate", async () => {
    const id = "11111111-1111-4111-8111-111111111111";
    expect(await tryClaimBatch(id)).toBe(true);
    expect(await tryClaimBatch(id)).toBe(false);
  });

  test("concurrent claims grant exactly one winner", async () => {
    const id = "22222222-2222-4222-8222-222222222222";
    const results = await Promise.all([
      tryClaimBatch(id),
      tryClaimBatch(id),
      tryClaimBatch(id),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  test("released batch id can be claimed again", async () => {
    const id = "33333333-3333-4333-8333-333333333333";
    expect(await tryClaimBatch(id)).toBe(true);
    await releaseBatch(id);
    expect(await tryClaimBatch(id)).toBe(true);
  });

  test("releasing an unclaimed batch id does not throw", async () => {
    await expect(
      releaseBatch("44444444-4444-4444-8444-444444444444"),
    ).resolves.toBeUndefined();
  });

  // DB errors must propagate (the handler's finally releases the claim and
  // Express maps the rejection to a 5xx) — not be swallowed as false.
  test("claim rejects when the insert fails", async () => {
    vi.spyOn(prisma.telemetryBatch, "createMany").mockRejectedValueOnce(
      new Error("db down"),
    );
    await expect(
      tryClaimBatch("55555555-5555-4555-8555-555555555555"),
    ).rejects.toThrow("db down");
  });
});
