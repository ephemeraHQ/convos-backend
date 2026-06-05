#!/usr/bin/env tsx
/**
 * SKU deploy CLI. Reads config/subscriptions.catalog.yaml as the source of
 * truth and reconciles Apple App Store Connect + Google Play Console to
 * match. Dry-run by default — pass --apply to mutate.
 *
 * Usage:
 *   pnpm tsx scripts/sku/apply.ts [--apple | --google | --all]
 *                                 [--dry-run | --apply]
 *                                 [--allow-create]
 *                                 [--product <productId>]
 *                                 [--json]
 *                                 [--catalog <path>]
 */
import { exit } from "node:process";
import pc from "picocolors";
import { AppError } from "@/utils/errors";
import * as apple from "./apple-connect";
import { DEFAULT_CATALOG_PATH, loadCatalog } from "./catalog";
import { diffCatalog, hasChanges } from "./diff";
import * as google from "./google-play-catalog";
import { renderApplyResults, renderDiffs } from "./reporter";
import type { ApplyResult, Catalog, ProductDiff } from "./types";

type Args = {
  stores: { apple: boolean; google: boolean };
  apply: boolean;
  allowCreate: boolean;
  product: string | null;
  json: boolean;
  catalogPath: string;
};

const requireFlagValue = (argv: string[], index: number, flag: string) => {
  const value: string | undefined = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new AppError(400, `Missing value for ${flag}`);
  }
  return value;
};

const parseArgs = (argv: string[]): Args => {
  const args: Args = {
    stores: { apple: true, google: true },
    apply: false,
    allowCreate: false,
    product: null,
    json: false,
    catalogPath: DEFAULT_CATALOG_PATH,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--apple":
        args.stores = { apple: true, google: false };
        break;
      case "--google":
        args.stores = { apple: false, google: true };
        break;
      case "--all":
        args.stores = { apple: true, google: true };
        break;
      case "--apply":
        args.apply = true;
        break;
      case "--dry-run":
        args.apply = false;
        break;
      case "--allow-create":
        args.allowCreate = true;
        args.apply = true;
        break;
      case "--json":
        args.json = true;
        break;
      case "--product":
        args.product = requireFlagValue(argv, i, "--product");
        i++;
        break;
      case "--catalog":
        args.catalogPath = requireFlagValue(argv, i, "--catalog");
        i++;
        break;
      case "--help":
      case "-h":
        printHelp();
        exit(0);
        break;
      default:
        throw new AppError(400, `Unknown flag: ${a}`);
    }
  }
  return args;
};

const printHelp = () => {
  console.log(
    `Subscription SKU deploy script

Usage: pnpm tsx scripts/sku/apply.ts [flags]

Flags:
  --all                 Reconcile both Apple and Google (default)
  --apple               Apple only
  --google              Google only
  --dry-run             Print diff without mutating (default)
  --apply               Apply changes
  --allow-create        Permit creation of brand-new Apple subscriptions
                        (requires App Review afterwards). Implies --apply.
  --product <id>        Restrict to a single productId
  --json                Machine-readable diff output
  --catalog <path>      Override catalog path
                        (default: config/subscriptions.catalog.yaml)
  --help, -h            Show this help
`,
  );
};

const filterCatalog = (catalog: Catalog, product: string | null): Catalog => {
  if (!product) return catalog;
  const filtered = catalog.products.filter((p) => p.productId === product);
  if (filtered.length === 0) {
    throw new AppError(400, `Product ${product} not found in catalog`);
  }
  return { ...catalog, products: filtered };
};

const applyAll = async (
  catalog: Catalog,
  diffs: ProductDiff[],
  subscriptionGroupId: string | null,
  args: Args,
): Promise<ApplyResult[]> => {
  const results: ApplyResult[] = [];

  for (const d of diffs) {
    if (!hasChanges(d)) continue;
    const desired = catalog.products.find((p) => p.productId === d.productId);
    if (!desired) continue;

    const perProduct: Array<Promise<ApplyResult>> = [];

    if (d.apple && d.apple.ops.length > 0) {
      if (!subscriptionGroupId) {
        throw new AppError(
          500,
          "applyAll: subscriptionGroupId missing for Apple branch",
        );
      }
      const groupId = subscriptionGroupId;
      perProduct.push(
        (async (): Promise<ApplyResult> => {
          try {
            // Re-fetch immediately before apply to ensure the diff hasn't gone stale.
            const remote = await apple.fetchRemote(desired.productId, groupId);
            const applied = await apple.apply(desired, remote, groupId, {
              allowCreate: args.allowCreate,
            });
            return {
              productId: desired.productId,
              store: "apple",
              ok: true,
              appliedOps: applied,
            };
          } catch (err) {
            return {
              productId: desired.productId,
              store: "apple",
              ok: false,
              appliedOps: 0,
              errorMessage: err instanceof Error ? err.message : String(err),
            };
          }
        })(),
      );
    }
    if (d.google && d.google.ops.length > 0) {
      perProduct.push(
        (async (): Promise<ApplyResult> => {
          try {
            const remote = await google.fetchRemote(desired.productId);
            const applied = await google.apply(desired, remote);
            return {
              productId: desired.productId,
              store: "google",
              ok: true,
              appliedOps: applied,
            };
          } catch (err) {
            return {
              productId: desired.productId,
              store: "google",
              ok: false,
              appliedOps: 0,
              errorMessage: err instanceof Error ? err.message : String(err),
            };
          }
        })(),
      );
    }

    results.push(...(await Promise.all(perProduct)));
  }

  return results;
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  const catalog = filterCatalog(loadCatalog(args.catalogPath), args.product);

  const { diffs, subscriptionGroupId } = await diffCatalog(catalog, {
    stores: args.stores,
  });

  if (args.json) {
    console.log(JSON.stringify({ diffs }, null, 2));
  } else {
    console.log(renderDiffs(diffs));
  }

  const anyChanges = diffs.some(hasChanges);
  if (!anyChanges) {
    console.log(pc.green("No changes."));
    return;
  }

  if (!args.apply) {
    console.log(
      pc.gray(
        "Dry-run. Pass --apply to make these changes (and --allow-create for Apple creates).",
      ),
    );
    return;
  }

  // Safety: if any Apple diff is a create and --allow-create is missing,
  // refuse before mutating anything.
  const appleCreates = diffs
    .filter((d) => d.apple?.isAppleCreate === true)
    .map((d) => d.productId);
  if (appleCreates.length > 0 && !args.allowCreate) {
    console.error(
      pc.red(
        `Refusing to apply: would create new Apple subscriptions [${appleCreates.join(", ")}] without --allow-create.`,
      ),
    );
    exit(2);
  }

  // Materialize the Apple subscription group now (the diff path is read-only
  // and leaves this null when the group doesn't exist yet).
  const hasAppleWork = diffs.some((d) => (d.apple?.ops.length ?? 0) > 0);
  const resolvedGroupId =
    subscriptionGroupId ??
    (hasAppleWork && args.stores.apple
      ? await apple.findOrCreateSubscriptionGroup(
          catalog.subscriptionGroupReferenceName,
        )
      : null);

  const results = await applyAll(catalog, diffs, resolvedGroupId, args);
  console.log("");
  console.log(renderApplyResults(results));

  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    console.error(pc.red(`\n${failed.length} apply operation(s) failed.`));
    exit(1);
  }

  // Re-diff to confirm idempotency. If anything still differs, the catalog
  // has a field this script can't reconcile — a bug.
  console.log(pc.gray("\nRe-checking for drift after apply..."));
  const { diffs: postDiffs } = await diffCatalog(catalog, {
    stores: args.stores,
  });
  const stillDirty = postDiffs.filter(hasChanges);
  if (stillDirty.length > 0) {
    console.error(pc.red("\nDrift remaining after apply:"));
    console.error(renderDiffs(stillDirty));
    exit(2);
  }
  console.log(pc.green("Catalog and stores are in sync."));
};

main().catch((err: unknown) => {
  console.error(
    pc.red(err instanceof Error ? (err.stack ?? err.message) : String(err)),
  );
  exit(1);
});
