#!/usr/bin/env tsx

/**
 * Apple subscription reconcile — allowlist pilot CLI.
 *
 * Re-fetches Apple ground truth (Get All Subscription Statuses) for an
 * EXPLICIT allowlist of originalTransactionIds and reconciles the local
 * Subscription rows through the normal repository/ledger paths
 * (src/subscriptions/reconcile/service.ts). DRY-RUN by default: prints the
 * intended changes and writes nothing. `--apply` executes.
 *
 * Usage:
 *   pnpm subs:reconcile <originalTransactionId...> [--apply] [--env production|sandbox] [--actor <email>]
 *
 * Options:
 *   --apply            Execute the writes (default: dry-run, writes nothing).
 *   --env <e>          Pin the App Store Server API environment (production|
 *                      sandbox). Default: query the configured environment
 *                      first and fall back to the opposite host on a 4040010/
 *                      4040005 not-found (TestFlight OTXs live in sandbox).
 *   --actor <email>    Actor recorded on the AdminAudit rows written in apply
 *                      mode (default: subscription-reconcile-cli).
 *   -h, --help         Show this help.
 *
 * Unlike scripts/check-apple-subscription-status.ts (read-only, self-
 * contained), this job imports the server source: it needs the FULL server
 * env (DATABASE_URL, the APPLE_API_* block, PAYMENTS_GRANT_PLUS_MONTHLY, and
 * the vars @/config requires at load). Run it where that env exists — the
 * API container / a shell with the server .env — never with hand-assembled
 * partial env. Never prints env values.
 */
import { Environment } from "@apple/app-store-server-library";
import {
  runAppleAllowlistReconcile,
  type OtxReconcileResult,
} from "@/subscriptions/reconcile/service";
import { prisma } from "@/utils/prisma";

const USAGE = `Usage:
  pnpm subs:reconcile <originalTransactionId...> [--apply] [--env production|sandbox] [--actor <email>]

Reconciles the local Subscription rows for an explicit allowlist of Apple
originalTransactionIds against Apple's Get All Subscription Statuses.
DRY-RUN by default (prints intended changes, writes nothing); --apply executes.

Options:
  --apply          Execute (row update + idempotent per-period grant/forfeit
                   through the ledger helpers + AdminAudit row).
  --env <e>        Pin the App Store Server API environment: production |
                   sandbox. Default: configured environment first, opposite
                   host on a 4040010/4040005 not-found.
  --actor <email>  Actor for AdminAudit rows (apply mode).
  -h, --help       Show this help.

Requires the full server env (DATABASE_URL, APPLE_API_*, ...). Exits non-zero
when any allowlisted id could not be fully processed (no_row,
provider_unresolved, skipped_row_changed, error).`;

const FAILURE_OUTCOMES: ReadonlySet<OtxReconcileResult["outcome"]> = new Set([
  "no_row",
  "provider_unresolved",
  "skipped_row_changed",
  "error",
]);

const describeMoney = (result: OtxReconcileResult): string[] => {
  const lines: string[] = [];
  const { forfeit, grant } = result.money;
  if (forfeit) {
    const verdict = forfeit.result
      ? `-> ${forfeit.result}`
      : forfeit.priorGrantExists
        ? "(a sub_grant row exists for that period; the helper will claw back only the unused portion)"
        : "(NO sub_grant row for that period -> forfeit will no-op; zero ledger movement)";
    lines.push(`forfeit period ${forfeit.periodStart} ${verdict}`);
  }
  if (grant) {
    const verdict = grant.result
      ? `-> ${grant.result}`
      : grant.alreadyGranted
        ? "(already granted -> idempotent replay, no ledger movement)"
        : `(would write a ${grant.credits}-credit sub_grant row)`;
    lines.push(`grant period ${grant.periodStart} ${verdict}`);
  }
  if (lines.length === 0) lines.push("none (status-only change)");
  return lines;
};

const printResult = (result: OtxReconcileResult) => {
  console.log(`\n== ${result.originalTransactionId} ==`);
  console.log(`  outcome: ${result.outcome}`);
  if (result.unresolvedReason)
    console.log(`  reason: ${result.unresolvedReason}`);
  if (result.error) console.log(`  error: ${result.error}`);
  if (result.subscriptionId)
    console.log(
      `  subscription: ${result.subscriptionId} (account ${result.accountId})`,
    );
  if (result.before)
    console.log(
      `  row before: status=${result.before.status} period=[${result.before.currentPeriodStart} .. ${result.before.currentPeriodEnd}] grace=${result.before.gracePeriodEnd ?? "-"} env=${result.before.environment ?? "-"}`,
    );
  if (result.provider)
    console.log(
      `  apple says: status=${result.provider.appleStatus ?? "?"} expires=${result.provider.expiresDate ?? "?"} (answered by ${result.provider.environment})`,
    );
  if (result.intendedUpdate)
    console.log(`  row update: ${JSON.stringify(result.intendedUpdate)}`);
  if (result.after)
    console.log(
      `  row after:  status=${result.after.status} period=[${result.after.currentPeriodStart} .. ${result.after.currentPeriodEnd}] grace=${result.after.gracePeriodEnd ?? "-"}`,
    );
  if (result.outcome === "planned" || result.outcome === "applied") {
    for (const line of describeMoney(result)) {
      console.log(`  money: ${line}`);
    }
  }
};

const main = async () => {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.log(USAGE);
    if (args.length === 0) process.exitCode = 1;
    return;
  }

  const otxIds: string[] = [];
  let apply = false;
  let environment: Environment | undefined;
  let actorEmail: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--apply") {
      apply = true;
    } else if (arg === "--env") {
      const value = args[++i];
      if (value === "production") environment = Environment.PRODUCTION;
      else if (value === "sandbox") environment = Environment.SANDBOX;
      else {
        console.error(`--env must be "production" or "sandbox"\n`);
        console.error(USAGE);
        process.exit(1);
      }
    } else if (arg === "--actor") {
      actorEmail = args[++i];
      if (!actorEmail || actorEmail.startsWith("-")) {
        console.error(`--actor requires an email argument\n`);
        console.error(USAGE);
        process.exit(1);
      }
    } else if (arg.startsWith("-")) {
      console.error(`Unknown option: ${arg}\n`);
      console.error(USAGE);
      process.exit(1);
    } else {
      otxIds.push(arg);
    }
  }

  if (otxIds.length === 0) {
    console.error(USAGE);
    process.exit(1);
  }

  console.log(
    `${apply ? "APPLY" : "DRY-RUN (no writes; pass --apply to execute)"} — ${otxIds.length} originalTransactionId(s)` +
      (environment ? ` — environment pinned to ${environment}` : ""),
  );

  const summary = await runAppleAllowlistReconcile({
    originalTransactionIds: otxIds,
    apply,
    environment,
    actorEmail,
  });

  for (const result of summary.results) {
    printResult(result);
  }

  const failures = summary.results.filter((r) =>
    FAILURE_OUTCOMES.has(r.outcome),
  );
  console.log(
    `\n${summary.mode}: ${summary.results.length} processed — ` +
      summary.results.map((r) => r.outcome).join(", "),
  );
  if (failures.length > 0) {
    process.exitCode = 1;
  }
};

main()
  .catch((error: unknown) => {
    console.error(
      error instanceof Error ? (error.stack ?? error.message) : String(error),
    );
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
