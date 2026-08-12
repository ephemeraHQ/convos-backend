/**
 * Preview-environment database seed (CON-825).
 *
 * Runs from the container entrypoint on every boot of a preview bundle and is
 * a no-op in every other environment. Two independent guards:
 *
 *   1. `PREVIEW` must be exactly "1". Nothing else in the estate sets it, so a
 *      dev/prod image running this file writes nothing and exits 0.
 *   2. A `RuntimeConfig` row with key `preview_seeded` must be absent. The
 *      marker is inserted with ON CONFLICT DO NOTHING as the FIRST statement of
 *      the seeding transaction, so it doubles as the concurrency guard: a
 *      second seeder blocks on the primary-key row lock, then observes
 *      `count === 0` and returns without writing. Everything else in the
 *      transaction rolls back with it, so a partially-seeded database is not
 *      reachable.
 *
 * `app_attest_enabled = "false"` is the load-bearing row. `appCheckOnlyMiddleware`
 * (src/middleware/auth.ts) defaults it to "true", so without it Firebase App
 * Check rejects every authenticated request and the preview is unusable.
 *
 * INVOCATION: `prisma db seed` (wired via package.json#prisma.seed) runs
 * `node prisma/seed.ts`. Node 24 strips types natively, so no tsx/ts-node is
 * needed — which matters because the release image prunes devDependencies.
 * For the same reason this file must use ERASABLE SYNTAX ONLY and must not use
 * the `@/` path alias (bare `node` does not resolve it).
 */
import { argv } from "node:process";
import { pathToFileURL } from "node:url";
import { PrismaClient } from "@prisma/client";

export const PREVIEW_SEED_MARKER_KEY = "preview_seeded";
export const PREVIEW_SEED_ATTEST_KEY = "app_attest_enabled";
export const PREVIEW_SEED_ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
export const PREVIEW_SEED_TEMPLATE_ID = "22222222-2222-4222-8222-222222222222";
export const PREVIEW_SEED_TEMPLATE_SLUG = "preview-helper";
export const PREVIEW_SEED_INVITE_CODES: readonly string[] = [
  "PREVIEW1",
  "PREVIEW2",
  "PREVIEW3",
];
export const PREVIEW_SEED_CREDITS = 100_000n;

export type SeedResult = "skipped-not-preview" | "already-seeded" | "seeded";

export async function seedPreview(prisma: PrismaClient): Promise<SeedResult> {
  if (process.env.PREVIEW !== "1") {
    return "skipped-not-preview";
  }

  return prisma.$transaction(
    async (tx): Promise<SeedResult> => {
      // Marker first: this INSERT ... ON CONFLICT DO NOTHING is the idempotency
      // guard AND the concurrency guard for two tasks booting at once.
      const marker = await tx.runtimeConfig.createMany({
        data: [
          {
            key: PREVIEW_SEED_MARKER_KEY,
            value: new Date().toISOString(),
          },
        ],
        skipDuplicates: true,
      });
      if (marker.count === 0) {
        return "already-seeded";
      }

      // Firebase App Check off. Upsert (not createMany) so the value is forced
      // even on the vanishingly unlikely fresh database that already carries a
      // "true" row from a migration default.
      await tx.runtimeConfig.upsert({
        where: { key: PREVIEW_SEED_ATTEST_KEY },
        create: { key: PREVIEW_SEED_ATTEST_KEY, value: "false" },
        update: { value: "false" },
      });

      await tx.inviteCode.createMany({
        data: PREVIEW_SEED_INVITE_CODES.map((code) => ({
          code,
          name: `Preview invite ${code}`,
          maxRedemptions: 100,
          batchLabel: "preview",
        })),
        skipDuplicates: true,
      });

      // Upsert, not create: if the marker row is ever deleted while the
      // fixtures survive (a partial database cleanup), a `create` would raise
      // P2002, roll the transaction back, and — because the entrypoint runs
      // `db seed` under `set -e` — wedge every subsequent container boot.
      await tx.account.upsert({
        where: { id: PREVIEW_SEED_ACCOUNT_ID },
        create: { id: PREVIEW_SEED_ACCOUNT_ID },
        update: {},
      });

      await tx.userCredits.upsert({
        where: { accountId: PREVIEW_SEED_ACCOUNT_ID },
        create: {
          accountId: PREVIEW_SEED_ACCOUNT_ID,
          balance: PREVIEW_SEED_CREDITS,
        },
        update: { balance: PREVIEW_SEED_CREDITS },
      });

      await tx.agentTemplate.upsert({
        where: { id: PREVIEW_SEED_TEMPLATE_ID },
        create: {
          id: PREVIEW_SEED_TEMPLATE_ID,
          slug: PREVIEW_SEED_TEMPLATE_SLUG,
          ownerAccountId: PREVIEW_SEED_ACCOUNT_ID,
          agentName: "Preview Helper",
          jobTitle: "Preview environment test agent",
          description:
            "Seeded agent template for per-PR preview environments. Not real data.",
          prompt:
            "You are a test agent running inside a Convos preview environment. Answer briefly and always mention that you are a seeded preview agent.",
          category: "productivity",
          emoji: "🧪",
          status: "published",
          firstPublishedAt: new Date(),
        },
        update: {},
      });

      return "seeded";
    },
    // Generous relative to the ~50ms of writes above: an Aurora Serverless v2
    // instance that has only just resumed is slow for its first few statements.
    { maxWait: 30_000, timeout: 60_000 },
  );
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const result = await seedPreview(prisma);
    console.log(`[preview-seed] ${result}`);
  } finally {
    await prisma.$disconnect();
  }
}

// Only run when executed directly (`prisma db seed` / `node prisma/seed.ts`).
// Under vitest, argv[1] is the vitest binary, so importing this module for its
// exports does not touch the database. Bound to a local so the truthiness check
// is on a `string` (an `=== undefined` comparison would trip
// @typescript-eslint/no-unnecessary-condition — argv is typed `string[]`).
const entryPoint = argv[1];
if (entryPoint && import.meta.url === pathToFileURL(entryPoint).href) {
  await main();
}
