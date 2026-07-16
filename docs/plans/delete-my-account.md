# Feature: Delete My Account (backend)

> **Status**: Draft
> **Created**: 2026-07-10
> **Companion plan**: convos-ios repo, `docs/plans/delete-my-account.md`

## Overview

Add an authenticated account-deletion endpoint that removes an account and all
of its server-side data apart from a small, documented set of retained records
(pseudonymized financial records, provider-key billing tombstones, the deletion
barrier, audit entries, and the deletion record itself; see the retention
sections below), erects a durable deletion barrier so the account
cannot be silently recreated, purges the account's footprint in external
systems (S3, XMTP notification server, Composio, analytics), and leaves
store-billing webhooks in a state where they neither error nor resurrect
account-linked rows.

Proposed route: `DELETE /v2/accounts/me`, matching the existing account-scoped
router convention (`/v2/accounts/me/credits`, `/v2/accounts/me/subscription`).
The exact path is a naming decision, not a design constraint.

## Problem Statement

No account-deletion route exists today. The `accountsMeRouter` exposes only
credits and subscription reads plus subscription verification, and every
existing `DELETE` route in the API is narrow cleanup (a single push-notification
client, a Composio connection or grant, admin content). Nothing removes an
`Account` row or its children.

Worse, the auth layer actively works against deletion as naively designed:
SIWE token generation upserts the `Account` and `AuthMethod` when the auth
method is absent, and grants the signup credit bonus to the fresh account. The
account-JWT middleware validates only that the token's account claim is
well-formed; it does not check that the account still exists. So a deletion
that merely removes rows is silently reversible: any later token mint from the
same identity key (a retry after token expiry, a paired device, or the iOS
client's automatic re-authentication on a 401) recreates the account and
re-grants the bonus. Preventing that recreation is as much a part of this
feature as the teardown itself.

Meanwhile the iOS app ships a "Delete all app data" action that is a local
reset, not a deletion: the server-side account, auth method, device
registrations, push tokens, credits, ledger, subscription records, uploaded
assets, and connection grants all survive. Apple App Store Guideline 5.1.1(v)
requires apps that support account creation to offer in-app account deletion
that removes the account record. Convos auto-provisions accounts without a
sign-up form, but the account is substantively real: it is JWT-addressable and
carries billing state, so the safe assumption is that the guideline applies.

## Goals

- [ ] Provide an authenticated endpoint that deletes the caller's account and
      all dependent rows in a single database transaction.
- [ ] Erect a durable deletion barrier keyed to the SIWE identity so that
      token minting, `requireAccount` routes, and subscription verification
      all fail closed for a deleted identity instead of auto-provisioning a
      replacement account.
- [ ] Purge the account's data in external systems (S3 public and private
      buckets, XMTP notification-server installations, Composio connected
      accounts, analytics identifiers) within a defined completion window.
- [ ] Keep store webhooks (Apple S2S, Google RTDN) and subscription
      verification functional after deletion: events for a deleted account's
      transactions must not error and must not recreate account-linked rows.
- [ ] Make the endpoint idempotent and the overall teardown resumable after
      partial failure, without relying on the client being able to query
      status after its keys are gone.
- [ ] Retain whatever financial records the business is obligated to keep, in
      explicitly pseudonymized form with documented scope and expiry, while
      erasing everything else.

## Non-Goals

- Cancelling the user's App Store or Google Play subscription. Store billing
  relationships belong to Apple/Google; the client discloses this to the user
  (see the iOS plan).
- Deleting XMTP conversation content. Message history lives on the XMTP
  network and other members' devices; the backend never held it. What happens
  to the XMTP inbox, its installations, and group memberships is owned by the
  iOS plan's XMTP lifecycle section.
- Remote-wiping other devices. The deletion barrier stops other devices of the
  same identity from minting new backend tokens (that is what actually cuts
  their backend access; nothing about deletion is otherwise permanent for a
  device that still holds the signing key), but their local storage and their
  XMTP-layer capabilities are out of the backend's reach.
- Account deactivation, grace periods, or undo. Accounts are anonymous and
  auto-provisioned; a deleted account is gone. Whether and how the same person
  can create a fresh account afterwards is a barrier policy decision (below),
  not a recovery feature.

## User Stories

### As a user, I want to delete my account so that Convos no longer holds any data about me

Acceptance criteria:

- [ ] After a successful call, the database transaction has removed or
      pseudonymized every row traceable to my identity — the only survivors
      are the documented retained classes (financial records, billing
      tombstones, the barrier, audit entries, and the deletion record), each
      under the pseudonymized-retention regime below — and my authentication
      is terminally dead: no token can be minted for my identity and no
      account-scoped route accepts a leftover token.
- [ ] My uploaded assets, notification-server registrations, Composio
      connected accounts, and analytics identifiers are purged within the
      published completion window (queued durably at commit time and drained
      with retries; see response semantics below).
- [ ] No retry, paired device, or automatic re-authentication recreates my
      account or re-grants the signup bonus.

### As the operator, I want deletion to be safe to retry so that a flaky network never strands an account half-deleted

Acceptance criteria:

- [ ] Calling the endpoint twice (or after a partial failure) converges to the
      same fully-deleted state and reports success.
- [ ] A token-mint attempt for a deleted identity returns a terminal
      "identity deleted" response, distinguishable from every generic auth
      failure, that clients can treat as deletion confirmation.
- [ ] A store webhook arriving after (or concurrently with) deletion is
      acknowledged without error and without recreating account-linked state.

## Technical Design

### Authentication and ordering

The endpoint is account-scoped: it must run behind `requireAccount`, which
means the caller needs an account JWT (ES256, 15-minute TTL) minted through a
SIWE signature produced with the account's identity key.

This creates the one ordering invariant that shapes the whole feature:
deletion must be callable while the client still holds its keys. Once the iOS
app wipes its keychain, it can no longer sign SIWE, so no new account JWT can
ever be minted; only an already-issued, unexpired token would still
authenticate. The contract with the client is therefore: call delete with a
valid account JWT, confirm success, and only then tear down local identity.
The companion iOS plan owns the client-side sequencing.

Two hardening notes:

- `requireAccount` currently trusts the JWT claim without checking that the
  account row exists. Deletion must make account-scoped routes fail closed
  for a deleted account even while a pre-deletion token is unexpired. The one
  deliberate exception is the deletion route itself: it authenticates through
  an endpoint-specific path that accepts a validly-signed, unexpired token
  for an already-deleted account solely to look up the deletion record (by
  account claim and operation id) and re-return the stored success. That path
  grants no other capability, and generic `requireAccount` is never loosened.
  Without this carve-out, the idempotency contract below would contradict
  fail-closed auth: a repeat call would be rejected before the handler could
  converge on success.
- Because deletion is irreversible, consider requiring a fresh token (issued
  within the last few minutes) rather than accepting any unexpired JWT, to
  narrow the window in which a stolen token can destroy an account. If
  adopted, the iOS client needs a force-refresh path: its SIWE machinery
  currently reuses any cached token with more than a minute of life left.
  This is a decision point, not a blocker.

### The deletion barrier

This is the core new invariant. Today, token minting auto-provisions: an
absent `AuthMethod` means "new user", so the mint upserts `Account` plus
`AuthMethod` and grants the signup bonus. After a deletion that merely removes
rows, the very next mint from the same key silently rebuilds the account.
Deletion therefore requires a durable barrier record keyed to the SIWE
external identity (the lowercased address stored today as
`AuthMethod.externalKey`), written inside the deletion transaction and
consulted before any auto-provisioning path:

- Token mint for a barred identity returns a terminal "identity deleted"
  response, explicitly distinguishable from nonce, signature, or transient
  auth failures. This response is the only signal clients may treat as
  deletion confirmation.
- Subscription verification and any other flow that can attach state to an
  account must also consult the barrier (see billing below).
- The barrier prevents the signup bonus from ever being re-granted to a
  barred identity by accident.

Barrier policy decisions (all must be settled before implementation):

- Permanence: is the bar forever, time-boxed, or lifted only by an explicit
  re-signup act? A permanent bar keyed to the address means the same identity
  key can never hold a Convos account again; a genuinely new account then
  requires new identity keys (which is what the iOS flow produces anyway).
- Intent disambiguation: how is a deliberate future account creation
  distinguished from an ambiguous deletion retry? A deletion operation id,
  generated by the client and persisted before its first request, gives
  ambiguous retries a clean contract; an explicit "create new account"
  assertion at mint time is the complement on the re-signup side.
- Barrier record minimization: the barrier itself retains a derivative of the
  identity (the address, or a keyed hash of it). That is pseudonymous data
  and needs the same purpose and retention documentation as the financial
  records below. A keyed hash rather than the raw address is the likely
  shape; either way it is retention and must be documented as such.

### Database teardown

There is no cascade root. `Account` deletion is blocked by `ON DELETE
RESTRICT` on `AuthMethod`, `UserCredits`, `CreditLedger`, `Subscription`,
`AgentTemplate`, and `AgentTemplateGeneration`; only `ConnectionGrant`
cascades, and `DeviceRegistration` merely nulls its account link. The
`RESTRICT` relations are a feature: they force an explicit, reviewed decision
per table, and they should stay.

Concurrent writers need fencing, not just a transaction, and a barrier check
on its own is a TOCTOU: a writer can consult the barrier before the deletion
transaction commits (seeing none) and attach an account-linked row after the
sweep has passed. The schema does not stop this — `ClientIdentifier.accountId`
and `AdminAudit.accountId` are plain scalars with no FK, and
`DeviceRegistration`'s FK is SET NULL, so the final `Account` delete would
quietly unlink a late row (stranding its push token) rather than fail. The
primary fence is therefore a parent-row lock protocol:

- The deletion transaction's first statement locks the account row —
  `SELECT id FROM "Account" WHERE id = $1 FOR UPDATE` — before any teardown
  statement runs. Taking the exclusive lock only via the final `DELETE` of
  the `Account` row would not be sound: children are torn down first, so the
  sweep would run before the lock exists and the race would survive.
- Every writer that attaches account-linked state calls a shared helper
  (`requireLiveAccount(tx, accountId)`) inside its own transaction:
  `SELECT 1 FROM "Account" WHERE id = $1 FOR KEY SHARE`, aborting when no
  row comes back. That one statement is both the existence check and the
  serialization point. The helper is mandatory at the FK-less writers — the
  `ClientIdentifier` upsert in notification subscribe and `AdminAudit`
  inserts — and is uniformity at the FK-backed ones (`DeviceRegistration`,
  `Subscription`, ledger writes), whose referential-integrity checks already
  take the same implicit `FOR KEY SHARE` on the parent row.
- The lock modes do the work: `FOR KEY SHARE` conflicts with the deletion's
  `FOR UPDATE` but not with other `FOR KEY SHARE` holders, so writers
  serialize against deletion only, never against each other. Under READ
  COMMITTED, a writer that blocks on the lock re-reads the row once deletion
  commits, finds it gone, and aborts; a writer that acquired its lock first
  commits ahead of the deletion, whose sweep statements — each taking a
  fresh snapshot after the lock was acquired — then see and remove its rows.

The honest cost is one shared helper called from the four or five writer
sites that stamp an accountId today. The barrier's fail-closed behavior and
the final `ClientIdentifier`/`DeviceRegistration` sweep (with the
external-purge outbox snapshotted from it) remain as defense in depth, not
as the primary mechanism.

Teardown runs inside one transaction, children before parents:

| Model                   | Current FK behavior                                                     | Proposed handling                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| BillingReceipt          | RESTRICT (via Subscription)                                             | Move raw signed payloads to the restricted retention store or delete; see financial records below                                                                                                                                                                                                                                                                                                              |
| Subscription            | RESTRICT                                                                | Convert to a provider-key tombstone; see billing below                                                                                                                                                                                                                                                                                                                                                         |
| CreditLedger            | RESTRICT                                                                | Retain pseudonymized or delete; see financial records below                                                                                                                                                                                                                                                                                                                                                    |
| UserCredits             | RESTRICT                                                                | Delete                                                                                                                                                                                                                                                                                                                                                                                                         |
| AgentTemplateGeneration | RESTRICT                                                                | Delete; queue private-bucket attachment purge                                                                                                                                                                                                                                                                                                                                                                  |
| AgentTemplate           | RESTRICT (forks SET NULL)                                               | Delete or anonymize; published templates are a decision point; queue avatar purge                                                                                                                                                                                                                                                                                                                              |
| AuthMethod              | RESTRICT                                                                | Delete, and write the deletion barrier in the same transaction                                                                                                                                                                                                                                                                                                                                                 |
| ClientIdentifier        | Scalar accountId, no FK to Account; CASCADE only via DeviceRegistration | Delete by direct accountId query, not only via the device cascade: stale rows whose device has since re-registered under another account are unreachable through the account's current devices. The direct query deletes every row carrying the accountId (current and stale alike), making the device cascade a redundant backstop. Queue remote notification-server installation removal for every row found |
| DeviceRegistration      | SET NULL                                                                | Delete the rows outright (they hold push tokens); do not settle for unlinking                                                                                                                                                                                                                                                                                                                                  |
| ConnectionGrant         | CASCADE                                                                 | Cascades; remote Composio purge is enumerated separately (below), not derived from grants                                                                                                                                                                                                                                                                                                                      |
| AdminAudit              | No FK                                                                   | Retain for ops accountability, but record a deletion audit entry; whether old entries keep the raw account id or get re-keyed is a decision point                                                                                                                                                                                                                                                              |
| Account                 | root                                                                    | Delete last; the durable deletion record and billing tombstones carry whatever must survive                                                                                                                                                                                                                                                                                                                    |

Ownerless tables (RuntimeConfig, InviteCode, InviteCodeRedemption, AuthNonce,
GrantKind, TelemetryBatch, AgentVariant) are untouched.

### Financial records: retention is pseudonymization, not anonymization

The obvious framing of "anonymize the financial records" does not survive
contact with the data:

- Apple receipts are signed JWS blobs. Identity-bearing claims such as
  `appAccountToken` cannot be stripped while retaining the original signed
  payload; retaining the payload means retaining those claims.
- Google's stored purchase JSON can contain `obfuscatedExternalAccountId`.
- Provider transaction identifiers are persistent pseudonymous identifiers by
  construction.
- Hashing an account id produces a stable pseudonym, not anonymous data.

So the honest design is a documented pseudonymized-retention regime, not
anonymization. Before implementation, for each retained class (billing
receipts, subscription tombstones, credit ledger, admin audit, the deletion
record and barrier themselves), document:

- purpose and lawful or contractual justification;
- the exact fields retained;
- the pseudonymization method (keyed hash, re-keying, payload isolation);
- access controls (raw signed receipts likely belong in a restricted
  financial store, not the primary application tables);
- a fixed retention period and the expiry job that enforces it;
- how existing `AdminAudit.accountId` values are handled at deletion time;
- the handoff boundary: retention writes must be atomic with the teardown —
  if the restricted store is the same database, they happen inside the
  deletion transaction; if it is external, a durable copy is completed and
  verified before the deletion transaction commits, with reconciliation and
  expiry owned by the retention job either way.

One implementation constraint is already settled by repo law: nothing outside
`src/payments/ledger/` may write `UserCredits` or `CreditLedger`
(`src/payments/AGENTS.md`). The teardown therefore calls a deletion-specific
helper inside the ledger module rather than deleting those rows directly, so
the single-writer invariant survives this feature.

This remains a business/legal decision point that blocks implementation of
this section, and the user-facing deletion copy must not promise erasure of
"all server data" while these records exist (owned by the iOS plan).

### Billing: tombstones, webhooks, verify, and re-subscribe

Subscription state is keyed by `originalTransactionId` (Apple) and
`purchaseToken` (Google), not by `accountId`, and `Subscription.accountId` is
a non-null FK. A deleted subscription therefore needs durable provider-key
state outside the live subscription row. The implementation carries that
state on `SubscriptionLineage`: deletion removes the account-linked
subscription and flips the locked lineage to `tombstoned`. Entitlement
lookups treat a tombstoned key as no entitlement. Recursive Google aliases
remain active for ordinary verify and RTDN accounting; tombstoned token
rotation absorption is deferred.

The tombstone must define a small state machine covering:

- Webhook ingestion: the current Apple and Google handlers update known
  subscriptions and acknowledge unknown ones; they do not recreate rows on
  their own. Post-deletion events for tombstoned keys must be acknowledged
  without recreating account-linked state.
- Verification: the account-linked recreation path is authenticated
  subscription verify combined with SIWE auto-provisioning. Both the deletion
  barrier (at mint) and a tombstone check (at verify) are required so a
  deleted user's still-active store subscription cannot silently rebind.
- Google token rotation: purchase tokens rotate and chain to linked tokens.
  Recursive alias resolution remains required for verify and RTDN accounting.
  Absorbing rotations into a tombstoned lineage is deferred to a follow-up.
- Concurrency: webhook processing currently looks up the subscription before
  its transaction. Deletion racing a webhook must converge (in either order)
  to tombstone-plus-no-op, not to a recreated or orphaned row. This needs
  defined locking or upsert semantics, not just replay tests.
- Restore and transfer: the user may keep paying after deletion. If they
  later create a genuinely new account (new identity keys), does the active
  store subscription transfer to it via verify? A permanent no-op tombstone
  blocks entitlement restoration for a paying customer; automatic rebinding
  undermines the deletion barrier. An explicit transfer policy is a decision
  point; the default proposal is manual, support-mediated transfer only.

Deleting the account does not cancel the store-side auto-renewing
subscription; the client must disclose this during the deletion flow (owned
by the iOS plan).

### External purges

The remote systems below hold account data; none of them is touched by any
existing deletion path. Purge targets are snapshotted inside the deletion
transaction (before the rows that identify them are deleted) into a durable
outbox, and drained with retries afterwards.

- S3 public assets bucket, tracked objects: avatars and published-template
  assets referenced by `AgentTemplate.avatarUrl`.
- S3, untracked objects: the general attachment presign flow issues random,
  non-account-prefixed keys with no ownership mapping (this includes
  conversation attachments, not just template assets), and private
  build-upload keys are likewise random, with presigning available under
  optional or anonymous auth, so abandoned uploads cannot be enumerated per
  account. Decision point: either these objects are declared retained as
  immutable message content (and disclosed as such in the deletion copy), or
  deleting them requires introducing an ownership/reference index plus a
  policy for content still referenced by peers. Independent of that choice,
  both buckets need a lifecycle/TTL policy for unreferenced and abandoned
  objects.
- XMTP notification server: one installation per `ClientIdentifier`
  (including stale rows found by the direct accountId query), removed via the
  existing delete-installation client call.
- Composio: connected accounts are keyed by backend account id directly and
  can exist with no grant or only revoked grants. Purge must enumerate via
  the service's list-for-user call and delete every returned connection, not
  derive targets from `ConnectionGrant` rows. Pending OAuth link requests
  must be cancelled or swept post-deletion so one cannot complete afterwards
  and recreate third-party state. The deletion barrier doubles as the durable
  fence here: link completion must consult it and refuse for a deleted
  account. Because grant-less connections are only discoverable remotely, the
  outbox worker re-runs list-for-user discovery post-commit — not just the
  in-transaction snapshot — and deletes everything found, with durable
  retries.
- Analytics and telemetry: backend builder analytics uses the account id
  directly as the PostHog distinct id. Deletion must either issue a PostHog
  person deletion or document retention; the same policy question covers
  Sentry events and operational logs that carry account or device
  identifiers. (Client-side analytics identity reset is owned by the iOS
  plan.)

### Response semantics, idempotency, and partial failure

Chosen contract: the endpoint returns success once the database transaction
commits. That transaction includes the full row teardown, the deletion
barrier, the billing tombstones, and the durable outbox of snapshotted
external purge targets. External purges are asynchronous behind that commit,
drained with retries, with a published completion window (the purge SLA,
target on the order of hours; the exact number is a decision point) and
alerting when a deletion record exceeds it.

Why asynchronous: coupling the response to three external systems makes the
user-facing flow hostage to the slowest third party, and a failure after the
database commit cannot be rolled back anyway. The consequences are owned
openly:

- The client may announce deletion while some external data is still
  draining. The iOS confirmation copy must say "within N hours", not
  "instantly".
- Once the client wipes its keys it has no authenticated way to query
  completion, so the contract is one-shot by design: commit-plus-barrier is
  the promise, the outbox drain is the operator's obligation, and stuck
  drains page an operator rather than the user.
- Terminal purge failures (for example a Composio connection that can no
  longer be deleted remotely) get a defined operator remediation path, not
  silent abandonment.
- The deletion record and outbox themselves necessarily retain account-linked
  identifiers and object keys until drained. They get the same treatment as
  other retained classes: restricted access, a defined purpose, and deletion
  of the record itself once the drain completes plus a bounded audit window.

Idempotency and retries:

- Repeat calls while a pre-deletion token is still valid return success,
  converging on the same deletion record. They do so via the deletion route's
  endpoint-specific auth path (see the hardening notes under authentication),
  which resolves the deletion record for an already-deleted account instead
  of being bounced by fail-closed `requireAccount`.
- After token expiry, a retry begins with a token mint, which hits the
  deletion barrier and returns the terminal identity-deleted response; the
  client treats that as confirmation. A generic 401 or SIWE failure is never
  confirmation (it can equally mean nonce, signature, or service problems).
- A client-generated deletion operation id, sent with the request and echoed
  in the deletion record, lets an ambiguous outcome be resolved without
  guessing.

### Abuse and rate limiting

Deletion is authenticated, destructive, and cheap to call. Rate-limit it per
device and per IP like other sensitive routes, and log attempts. The main
abuse vector is a stolen unexpired JWT (15-minute window); the fresh-token
requirement above is the mitigation lever. App Check currently gates only
device registration and telemetry; extending it to this route is optional
hardening, not a dependency. The barrier's terminal response at the mint
endpoint is pre-authentication; it should not leak more than "this identity
cannot mint tokens".

### Observability and audit

- Emit metrics for deletion requests, completions, barrier hits at mint and
  verify, tombstone no-op webhook events, and per-external-system purge
  failures; alert on deletion records exceeding the purge SLA.
- Write an `AdminAudit` entry for each deletion with a non-identifying
  reference (a keyed hash, consistent with the barrier's minimization
  choice) so operators can answer "was this account deleted, and when"
  without retaining the identity.

## Implementation Plan

### Phase 1: barrier, endpoint, and transactional teardown

- [ ] Deletion barrier record, checked at token mint (terminal response) and
      wired into `requireAccount` fail-closed behavior, plus the deletion
      route's endpoint-specific idempotent-retry auth path.
- [ ] Route, auth wiring, request validation, rate limiting, operation id.
- [ ] Deletion record, outbox snapshot, and the ordered database transaction
      (including the direct `ClientIdentifier.accountId` sweep).
- [ ] Idempotent success semantics and the barrier-based retry contract.

### Phase 2: billing tombstones

- [ ] Provider-key tombstone model; no-op handling in Apple and Google
      webhook processing and in subscription verification; token-rotation
      absorption; deletion-vs-webhook concurrency semantics.

### Phase 3: external purges and retention enforcement

- [ ] S3 tracked-object purge for both buckets; decision and implementation
      for untracked attachments (retain-and-disclose vs ownership index);
      bucket lifecycle/TTL for abandoned objects.
- [ ] Notification-server installation removal per client identifier.
- [ ] Composio purge via list-for-user plus pending-link cancellation.
- [ ] Analytics identifier deletion or documented retention.
- [ ] Outbox drain mechanics, purge SLA alerting, deletion-record expiry job,
      and retention-schedule enforcement for all retained classes.

## Testing Strategy

- Unit tests for: teardown ordering against a fully-populated account (every
  child table occupied); idempotent second call; barrier hit at mint
  returning the terminal response with no account or bonus recreation;
  fail-closed `requireAccount` for a deleted account holding an unexpired
  token; tombstone no-op paths; the direct `ClientIdentifier.accountId`
  sweep, including stale rows pointing at re-registered devices.
- Integration tests for: the full transaction against a real database;
  webhook replay after deletion (acknowledged, no recreation);
  partial-failure resume (kill between database commit and each external
  purge, verify the outbox drains on retry, independent of any further
  authenticated client request).
- Race tests, not just replay tests: deletion concurrent with Apple/Google
  webhook processing; deletion concurrent with subscription verification; a
  Composio link request completing during deletion; a push registration
  arriving while device and client rows are being snapshotted; deletion
  concurrent with a subscription period grant (an SSN renewal materializing
  credits through the ledger mid-teardown).
- Schema guards: a test asserting that deleting an `Account` with children
  still fails at the database layer (so a future schema change cannot
  silently weaken the RESTRICT protections), and an inventory-enforcement
  test that flags new account-correlatable tables or external integrations
  for inclusion in the teardown table, not just new restrictive FKs.

## Risks & Mitigations

| Risk                                                                                                   | Impact                                  | Mitigation                                                                                                    |
| ------------------------------------------------------------------------------------------------------ | --------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| SIWE auto-provisioning silently recreates a deleted account (retry, paired device, client auto-reauth) | High                                    | Deletion barrier at token mint with a terminal response; barrier checks at verify; fail-closed requireAccount |
| Retention framed as anonymization overpromises erasure                                                 | High                                    | Pseudonymized-retention regime with per-class purpose, fields, access, and expiry; honest user-facing copy    |
| Store webhooks or verify recreate rows for deleted accounts                                            | Medium                                  | Provider-key tombstones consulted in webhooks and verify; concurrency semantics plus race tests               |
| Partial failure strands external data (S3, Composio, notification server)                              | Medium                                  | Transactional outbox snapshot; drain with retries; purge SLA with alerting and operator remediation           |
| Untracked S3 attachments are unenumerable per account                                                  | High (blocks the iOS confirmation copy) | Explicit decision: retain-and-disclose or ownership index; bucket lifecycle policy either way                 |
| Stolen JWT deletes an account                                                                          | Medium                                  | Fresh-token requirement; rate limiting; audit trail                                                           |
| Users expect deletion to stop billing                                                                  | Medium                                  | Client-side disclosure before deletion (iOS plan); tombstones keep webhook handling sane either way           |

## Open Questions

- [ ] Barrier permanence and re-signup policy: permanent bar per identity key
      (a new account then requires new keys), time-boxed, or liftable by an
      explicit re-signup assertion at mint?
- [ ] Barrier record shape: raw address vs keyed hash, and its retention
      period.
- [ ] Retention scope: which of CreditLedger and BillingReceipt must be
      retained, for how long, in what pseudonymized form, and where do raw
      signed receipts live? (Needs a business/legal decision.)
- [ ] Subscription transfer policy: can an active store subscription rebind
      to a genuinely new account, and through what explicit act?
- [ ] Untracked S3 attachments: retain as immutable message content (and
      disclose) or build an ownership/reference index?
- [ ] Analytics: delete the PostHog person and scrub Sentry/logs, or document
      retention windows?
- [ ] Purge SLA number, and the operator remediation path for terminal purge
      failures.
- [ ] Should the endpoint require a fresh SIWE-minted token? (If yes, the iOS
      client needs a force-refresh path; its SIWE machinery currently reuses
      cached tokens.)
- [ ] Do existing `AdminAudit` entries for the account get their account id
      re-keyed at deletion time, or retained as-is under the ops-audit
      carve-out?
- [ ] Does deletion forfeit the current period's remaining subscription
      credits (a ledger `forfeitSubscriptionPeriod` before the wallet goes),
      or is deleting the wallet itself sufficient erasure?

## Decided contract and defaults (as built)

The cross-repo wire contract (agreed with the companion iOS plan) and the
open-question resolutions this implementation shipped with:

- **Route/body**: `DELETE /v2/accounts/me`, JSON body `{ "operationId":
"<uuid v4, client-generated, persisted before first send>" }`; 200
  `{ "status": "deleted", "operationId", "deletedAt", "purgeWindowHours": 24 }`.
  Replays - same or different operationId, via the endpoint-specific
  carve-out - return the stored record, echoing the stored operationId.
- **Terminal identity-deleted**: 410 `{ "error", "code": "identity_deleted" }`
  at `POST /v2/auth/token`, only after full SIWE validation (no
  unauthenticated deletion oracle). The delete-200 and this 410 are the only
  confirmation channels.
- **Fail-closed requireAccount**: deleted account with an unexpired token
  gets a generic 401 on every other route; no positive existence caching
  anywhere on this boundary - every check hits the database.
- **Verify claimable signal**: ownership-mismatch/tombstone 409s keep code
  `subscription_account_mismatch` (append-only law) and gain the additive
  `claimable` boolean. Live ownership mismatches report `false`; Apple
  tombstones report `true`.
- **Barrier**: permanent, keyed hash (HMAC keyed by the dedicated
  `DELETION_HASH_SECRET`, which must never rotate).
- **Fresh-token requirement**: not in v1 (rate limits + audit instead).
- **Forfeit-before-wallet-delete**: superseded by custody escrow - the
  deletion transaction escrows the conservative period remainder for a
  future claim instead of just forfeiting it.
- **AdminAudit**: pre-existing entries retained as-is (ops carve-out); the
  deletion entry uses a sentinel account id with the keyed accountRef in
  `reason`.
- **Retention defaults**: BillingReceipt and CreditLedger rows are deleted
  outright (swappable single point: `deleteWalletForAccountWithTx` in the
  ledger module); the tombstoned lineage plus custody/registry rows are the
  pseudonymized retained billing trace; the DeletionRecord and outbox rows
  expire 30 days after the drain completes.
- **Untracked S3 attachments**: retain-and-disclose (immutable message
  content); bucket lifecycle policy is an ops follow-up.
- **PostHog**: person deletion via the private API (new optional
  `POSTHOG_PERSONAL_API_KEY` / `POSTHOG_PROJECT_ID`); when analytics is on
  and the credentials are missing, purge tasks retry and page ops.
- **Purge SLA**: 24 hours, returned as `purgeWindowHours` and alerted on
  breach (`deletion.purge.sla_breach`).
- **Ops kill switch**: RuntimeConfig `account_deletion_enabled` (default
  "true") gates the endpoint without a redeploy.

## References

- Companion client plan: convos-ios repo, `docs/plans/delete-my-account.md`.
- Apple App Store Review Guideline 5.1.1(v) (account deletion requirement).
- Apple developer guidance: "Provide options to delete your app's account".

## Relationship to subscription ownership restoration

The historical rationale in this plan considered tombstone restoration and live
ownership transfer. This branch ships Apple tombstone restoration only. Live
ownership transfer, its contest and undo machinery, Google claim proof, and
Play tombstone-rotation absorption are deferred to a follow-up.

## Subscription claim

One `SubscriptionLineage` row per purchase line (Apple originalTransactionId;
Google linkedPurchaseToken chain resolved to its root, rotated tokens kept as
aliases) is the canonical first lock for verify, webhooks, claims, and the
deletion teardown, and the tombstone carrier: deletion flips the lineage to
`tombstoned` instead of writing a separate tombstone table.
`LineagePeriodGrant` makes period funding global-once (keyed by the
provider funding event: Apple transactionId / Google latestOrderId), and
`LineagePeriodCustody` tracks each funded period's remaining value; every
move debits `D = min(lockedBalance, max(0, cap - consumesSince))` and sets
`cap := D`, so no sequence of deletion, restoration, or refund events can move
more than one period allotment and commingled promo/admin/signup credits never
move.

`POST /v2/accounts/me/subscription/claim` is the explicit one-time Apple
restoration act:

- Proof requirements are authoritative: verified artifact, provider-confirmed
  entitled-now, and latest-transaction match (no signedDate freshness window
  - it is not a challenge). Firebase App Check attestation with a
    limited-use, consumed token is mandatory and fails closed; there is no
    `app_attest_enabled` bypass on this route.
- Tombstone restoration (deleted owner): the deletion transaction escrowed
  the conservative remainder into custody; the claim releases the escrow to
  the claimant (never a second grant) and flips the lineage back to live.
  Controlled by `SUBSCRIPTION_CLAIM_TOMBSTONE_ENABLED`, which defaults on.
- Claims against live lineages deterministically fail closed. Google claim
  request shapes remain accepted for client compatibility but fail closed
  before any provider call. Google verify, RTDN, recursive alias resolution,
  grants, custody, escrow, void accounting, and reconciliation remain active.
- Live ownership transfer, contest notifications and settlement, undo, Google
  claim proof, and Play tombstone-rotation absorption are deferred to a
  follow-up.
