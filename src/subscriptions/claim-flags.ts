/**
 * Subscription-claim launch flags and constants. Read at call time (not
 * module load) so tests and ops can flip them without a restart. Launch
 * posture: tombstone restoration ON, live transfer OFF until security
 * sign-off; the contest window applies to live-tier claims whenever the
 * live flag is enabled (setting it to 0 — instant transfer — requires
 * explicit security acceptance).
 */

const flag = (name: string, fallback: boolean): boolean => {
  const raw = process.env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === "") return fallback;
  return raw === "true" || raw === "1";
};

export const isTombstoneClaimEnabled = (): boolean =>
  flag("SUBSCRIPTION_CLAIM_TOMBSTONE_ENABLED", true);

export const isLiveTransferEnabled = (): boolean =>
  flag("SUBSCRIPTION_CLAIM_LIVE_TRANSFER_ENABLED", false);

/**
 * Provider scope for the claim surface. The product is Apple-only today
 * (no Android app), so Google claims/restorations ship DISABLED behind
 * their own flag: the endpoint rejects googlePlay bodies with contract
 * not-claimable semantics before any provider call, and verify's
 * `claimable` signal stays false for Google lineages. Verify/RTDN ingest
 * and the Google money accounting (grants, custody, escrow, voids) remain
 * fully on so the books stay correct whichever day the flag flips.
 */
export const isGoogleClaimEnabled = (): boolean =>
  flag("SUBSCRIPTION_CLAIM_GOOGLE_ENABLED", false);

export const claimContestWindowHours = (): number => {
  const raw = process.env.CLAIM_CONTEST_WINDOW_HOURS?.trim();
  if (!raw) return 72;
  // Number (not parseInt): parseInt would truncate "0.5" to 0 and silently
  // disable the contest window - the exact outcome the module doc says
  // requires explicit security acceptance. Only whole non-negative hour
  // counts are honored; anything else falls back to the 72h default.
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : 72;
};

/** Lineage cooldown between transfers; previous-owner undo is exempt. */
export const SUBSCRIPTION_CLAIM_COOLDOWN_DAYS = 30;

/** One-shot undo deadline after a transfer. */
export const SUBSCRIPTION_CLAIM_UNDO_DEADLINE_DAYS = 30;
