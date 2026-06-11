import { prisma } from "@/utils/prisma";

// First writer wins: the INSERT itself is the duplicate gate (primary-key
// uniqueness), so two concurrent requests with the same batch id cannot both
// proceed — a check-then-insert pair would race between the check and the
// insert. Returns true when this call claimed the id.
export async function tryClaimBatch(batchId: string): Promise<boolean> {
  const { count } = await prisma.telemetryBatch.createMany({
    data: [{ batchId }],
    skipDuplicates: true,
  });
  return count === 1;
}

// A non-accepted outcome (validation failure, forward failure, unexpected
// error) must not poison the batch id, or the client's retry with the same
// Idempotency-Key would be dropped as a dup. Idempotent: releasing an
// unclaimed id is a no-op.
export async function releaseBatch(batchId: string): Promise<void> {
  await prisma.telemetryBatch.deleteMany({ where: { batchId } });
}
