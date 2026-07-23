// Entitlement lifecycle statuses and the Composio-derived mapping shared by
// the abilities read path, the boot-time backfill, and the V1 adapters
// (docs/plans/abilities-entitlements.md).

/**
 * The full server-owned lifecycle vocabulary, mirrored by the DB CHECK
 * constraint on AbilityEntitlement.status and by the wire enum in
 * docs/schemas/abilities.schema.json. needs_reauth is reserved for the
 * service-mediated revalidation job; revoked is set by explicit user
 * revocation (V2 DELETE entitlement, or a V1 disconnect that removes the
 * last credential).
 */
export const ENTITLEMENT_STATUSES = [
  "pending_auth",
  "active",
  "needs_reauth",
  "expired",
  "revoked",
] as const;

export type EntitlementStatus = (typeof ENTITLEMENT_STATUSES)[number];

/**
 * The subset a Composio connected-account state can map to. Everything that
 * is not usable and not in-flight (EXPIRED, REVOKED, FAILED, INACTIVE, or a
 * value outside the SDK union) collapses to `expired`: the credential cannot
 * be used and re-running OAuth is the remedy, which is what `expired` means
 * to the client.
 */
export type ComposioDerivedStatus = Extract<
  EntitlementStatus,
  "pending_auth" | "active" | "expired"
>;

/** The SDK's actual status union, for unknown-value warn logging. */
export const KNOWN_COMPOSIO_STATUSES: ReadonlySet<string> = new Set([
  "INITIALIZING",
  "INITIATED",
  "ACTIVE",
  "FAILED",
  "EXPIRED",
  "INACTIVE",
  "REVOKED",
]);

/** The subset of a logger this module needs (any pino logger satisfies it). */
type WarnLogger = { warn: (obj: object, msg: string) => void };

// Accepts plain string (not the SDK's ConnectedAccountStatus union) on
// purpose: SDK drift can serve values outside the union, and they must
// collapse to `expired` rather than fail to type-check. Callers pass their
// logger so a value outside the known union is warn-logged wherever it is
// mapped (backfill, adapters) — silent collapse would hide SDK drift.
export function toEntitlementStatus(
  composioStatus: string,
  log?: WarnLogger,
): ComposioDerivedStatus {
  if (log && !KNOWN_COMPOSIO_STATUSES.has(composioStatus)) {
    log.warn(
      { composioStatus },
      "[Abilities] unknown Composio connection status — mapping to expired",
    );
  }
  switch (composioStatus) {
    case "ACTIVE":
      return "active";
    case "INITIALIZING":
    case "INITIATED":
      return "pending_auth";
    default:
      return "expired";
  }
}

/**
 * An account can hold several Composio connections for one toolkit; the most
 * usable one determines the derived status (lower rank wins).
 */
export const COMPOSIO_DERIVED_STATUS_RANK: Record<
  ComposioDerivedStatus,
  number
> = {
  active: 0,
  pending_auth: 1,
  expired: 2,
};
