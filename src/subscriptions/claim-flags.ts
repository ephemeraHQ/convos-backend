/** Subscription-restoration flag, read at call time for runtime control. */

const flag = (name: string, fallback: boolean): boolean => {
  const raw = process.env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === "") return fallback;
  return raw === "true" || raw === "1";
};

export const isTombstoneClaimEnabled = (): boolean =>
  flag("SUBSCRIPTION_CLAIM_TOMBSTONE_ENABLED", true);
