import { prisma } from "@/utils/prisma";

export async function isDuplicateBatch(batchId: string): Promise<boolean> {
  const row = await prisma.telemetryBatch.findUnique({
    where: { batchId },
    select: { batchId: true },
  });
  return row !== null;
}

// Inserted only AFTER a successful forward: a forward failure must not
// poison the batch id, or the client's retry would be dropped as a dup.
export async function recordBatch(batchId: string): Promise<void> {
  await prisma.telemetryBatch.createMany({
    data: [{ batchId }],
    skipDuplicates: true,
  });
}
