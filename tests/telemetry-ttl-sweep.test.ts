import { beforeEach, describe, expect, test } from "vitest";
import { sweepExpiredBatches } from "@/api/v2/telemetry/services/ttl-sweep";
import { prisma } from "@/utils/prisma";

describe("telemetry ttl sweep", () => {
  beforeEach(async () => {
    await prisma.telemetryBatch.deleteMany();
  });

  test("deletes rows older than 48h, keeps fresh ones", async () => {
    await prisma.telemetryBatch.create({
      data: {
        batchId: "old-batch",
        receivedAt: new Date(Date.now() - 49 * 60 * 60 * 1000),
      },
    });
    await prisma.telemetryBatch.create({ data: { batchId: "fresh-batch" } });

    const deleted = await sweepExpiredBatches();

    expect(deleted).toBe(1);
    const remaining = await prisma.telemetryBatch.findMany();
    expect(remaining.map((r) => r.batchId)).toEqual(["fresh-batch"]);
  });
});
