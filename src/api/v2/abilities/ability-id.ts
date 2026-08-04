// Canonical ability-id normalization, shared by every boundary that stores,
// reads, backfills, or checks an ability id / Composio toolkit slug.
//
// Ability ids are case-insensitive identifiers whose canonical form is
// lowercase (Composio's canonical slugs are lowercase too). Mixed-case
// variants written by old clients used to split entitlement state into rows
// V2 lifecycle routes could not address (a canonical tombstone did not
// protect a case-variant row); normalizing once at every boundary removes
// that class of bug. The reconciliation sweep merges historical variant rows
// onto the canonical id (see backfill-entitlements.ts).
//
// The legacy ConnectionGrant.toolkit column keeps the client's original
// casing (its V1 wire echoes what was sent); legacy-table matching uses
// case-insensitive comparisons instead.
export function normalizeAbilityId(id: string): string {
  return id.toLowerCase();
}
