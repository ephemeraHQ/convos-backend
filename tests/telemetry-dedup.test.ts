import { beforeEach, describe, expect, test } from "vitest";
import {
  isDuplicateBatch,
  recordBatch,
} from "@/api/v2/telemetry/services/dedup";
import { prisma } from "@/utils/prisma";

describe("telemetry dedup", () => {
  beforeEach(async () => {
    await prisma.telemetryBatch.deleteMany();
  });

  test("unknown batch id is not a duplicate", async () => {
    expect(await isDuplicateBatch("11111111-1111-4111-8111-111111111111")).toBe(
      false,
    );
  });

  test("recorded batch id is a duplicate", async () => {
    const id = "22222222-2222-4222-8222-222222222222";
    await recordBatch(id);
    expect(await isDuplicateBatch(id)).toBe(true);
  });

  test("recordBatch is idempotent (no throw on conflict)", async () => {
    const id = "33333333-3333-4333-8333-333333333333";
    await recordBatch(id);
    await expect(recordBatch(id)).resolves.toBeUndefined();
  });
});
