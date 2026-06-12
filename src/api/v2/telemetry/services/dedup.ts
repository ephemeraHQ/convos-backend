import { prisma } from "@/utils/prisma";

// First writer wins: the INSERT itself is the duplicate gate (primary-key
// uniqueness), so two concurrent requests with the same batch id cannot both
// proceed — a check-then-insert pair would race between the check and the
// insert. Returns true when this call claimed the id.
//
// Accepted at-most-once edges (no in-flight lease, by design — this is
// telemetry, occasional loss beats added machinery):
// - A concurrent loser gets "duplicate" while the winner is still in flight;
//   if the winner then fails, the loser was told duplicate for a batch that
//   never forwarded. The winner's client sees the failure and retries.
// - A crash between claim and forward strands the row until the TTL sweep
//   (48h) releases it; retries in that window are dropped as duplicates.
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
