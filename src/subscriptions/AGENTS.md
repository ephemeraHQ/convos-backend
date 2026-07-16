# Subscriptions — lineage, custody, and the lock order

Read this before touching verify, webhooks, claims, or anything that moves
subscription credits. `src/payments/AGENTS.md` still governs the ledger
itself; this file governs the subscription layer above it.

## The lineage model

One `SubscriptionLineage` row per purchase line: Apple
`originalTransactionId`, or a Google `linkedPurchaseToken` chain resolved to
its root with every rotated token recorded in `LineageTokenAlias`. The
lineage row is:

- the **canonical first lock** for every money path (below);
- the **tombstone carrier** — account deletion flips `state` to
  `tombstoned`; webhooks ack tombstoned lineages as counted no-ops, verify
  returns 409 with `claimable: true`, and a claim restores the lineage.

`LineagePeriodGrant` is the global once-per-funding-event registry (one row
per Apple transactionId / Google latestOrderId), and `LineagePeriodCustody`
tracks who currently holds each funded period's remaining value. Custody —
not account-scoped `sub_grant` rows — is the source of truth for the
remainder after funding; every move debits by
`D = min(lockedOwnerBalance, max(0, cap - ownerConsumesSince(custodyStartedAt)))`
and sets `cap := D`, so no chain of escrow/restoration/refund exceeds the
allotment and commingled promo/admin credits never move.

## Global lock order (deadlock-free by construction)

1. `SubscriptionLineage` row(s), sorted by id — `lockLineage` returns a
   `LineageLockContext`, the type-level proof custody ops and lineage-scoped
   grants require.
2. `Account` row(s), sorted by id — `FOR UPDATE` for deletion, `FOR KEY
SHARE` via `requireLiveAccount` for writers (including inside
   `applyDeltaWithTx`).
3. `Subscription` row.
4. `UserCredits` wallet row(s) (`lockUserCreditsBalance`), sorted by account
   id when two wallets are involved.

Rules:

- Resolve-or-create the lineage OUTSIDE the money transaction (small,
  retryable step); the transaction's first statement is the lineage lock.
- A restart (deletion discovering an unlocked lineage, deadlock retry) means
  full rollback and a fresh transaction — never acquire a newly discovered
  lower-sorted lock while holding later ones.
- Google chains resolve recursively with loop detection (depth 10);
  conflicting chains are never auto-merged — they land in
  `LineageQuarantine` and the caller gets `LineageUnresolvedError`
  (retryable).

## Claim semantics (summary)

- Tombstone restoration: escrow release referencing the existing funding
  row — never a second grant.
- Live lineage and Google claim attempts fail closed; only Apple tombstone
  restoration is supported.
- App Check limited-use attestation is mandatory on the claim route and
  fails closed — no `app_attest_enabled` bypass.
