import * as apple from "./apple-connect";
import * as google from "./google-play-catalog";
import type {
  Catalog,
  DesiredProduct,
  ProductDiff,
  RemoteAppleProduct,
  RemoteGoogleProduct,
} from "./types";

export type DiffOptions = {
  stores: { apple: boolean; google: boolean };
};

const isEmpty = (d: { ops: { kind: string }[] } | null) =>
  d === null || d.ops.length === 0;

export const diffProduct = async (
  desired: DesiredProduct,
  subscriptionGroupId: string | null,
  opts: DiffOptions,
): Promise<ProductDiff> => {
  const tasks: Array<Promise<unknown>> = [];

  let appleRemote: RemoteAppleProduct = null;
  let googleRemote: RemoteGoogleProduct = null;

  if (opts.stores.apple) {
    if (!subscriptionGroupId) {
      throw new Error(
        "diffProduct: subscriptionGroupId is required when Apple is enabled",
      );
    }
    tasks.push(
      apple.fetchRemote(desired.productId, subscriptionGroupId).then((r) => {
        appleRemote = r;
      }),
    );
  }
  if (opts.stores.google) {
    tasks.push(
      google.fetchRemote(desired.productId).then((r) => {
        googleRemote = r;
      }),
    );
  }

  await Promise.all(tasks);

  return {
    productId: desired.productId,
    apple: opts.stores.apple ? apple.computeDiff(desired, appleRemote) : null,
    google: opts.stores.google
      ? google.computeDiff(desired, googleRemote)
      : null,
  };
};

export const diffCatalog = async (
  catalog: Catalog,
  opts: DiffOptions,
): Promise<{
  diffs: ProductDiff[];
  subscriptionGroupId: string | null;
}> => {
  // Apple needs the subscription group id resolved once up front. We do it
  // outside the per-product loop so we don't churn through the same API
  // calls four times.
  const subscriptionGroupId = opts.stores.apple
    ? await apple.findOrCreateSubscriptionGroup(
        catalog.subscriptionGroupReferenceName,
      )
    : null;

  // Sequential to keep Apple ratelimits happy. Google could be parallel
  // but at four products the win is negligible.
  const diffs: ProductDiff[] = [];
  for (const product of catalog.products) {
    diffs.push(await diffProduct(product, subscriptionGroupId, opts));
  }
  return { diffs, subscriptionGroupId };
};

export const hasChanges = (d: ProductDiff): boolean =>
  !isEmpty(d.apple) || !isEmpty(d.google);
