# SSN/verify ownership reconciliation — options note (decision deferred)

Status: **open question**, no decision. Written alongside the July 2026 fix
bundle (verify-replay grant materializer, AAT-conflict 409, daily-refill
kill-switch). This note only frames the problem and two candidate directions.

## The gap

A `Subscription` row belongs to the account that **first** verified it, and the
two write paths treat ownership asymmetrically:

- **Server notifications (Apple SSN / Play RTDN → `applyNotification`)** look
  the row up by provider identity (OTX / purchaseToken) and keep _enriching_ it
  no matter who owns it: status transitions, period advances, and — since the
  single-ledger migration — `grantSubscriptionPeriod` credits for every renewal,
  all landing on the row's (possibly dead) `accountId`.
- **Client verify (`upsertFromVerify`)** _refuses_ when the authenticated caller
  differs from the row's owner: `SubscriptionAccountMismatchError` → 409.

So after an account deletion + recreation (common: iOS reuses the per-install
`appAccountToken`, and Apple keeps renewing the same subscription), the person
keeps paying, Apple keeps notifying, renewals keep granting credits into the
orphaned old wallet — while the account the human actually uses gets a
truthful-but-dead-end 409 ("contact support"). The 409 is correct as a
_safety_ posture (fixed in this bundle to replace a 500); it is not a
_resolution_.

## Option A — provider-proven ownership transfer at verify time

When verify presents a **fresh, provider-verified** transaction (Apple-signed
JWS / Play API-confirmed purchase) whose provider identity matches a row owned
by another account, re-home the row — `accountId`, and therefore all future
SSN-driven grants — to the authenticated caller. Plausible gates: only when the
old account is deleted/inactive, or when the caller proves the same install
identity (same `appAccountToken` in the signed payload, not just the request).

- **Pros:** self-serve healing, zero support latency; renewals immediately
  enrich the right wallet; matches what the paying user meant.
- **Cons / open problems:**
  - Ownership transfer is an attack surface. A replayed receipt or leaked JWS
    must not steal a subscription; mitigations (freshness window, matching
    AAT inside the signed transaction, old-account-deleted gate, rate limits)
    each add real complexity and each have edge cases.
  - Money questions: the old wallet may hold already-granted period credits.
    Forfeit-from-old + grant-to-new is the clean ledger story but claws back a
    commingled wallet; leaving them double-counts the period.
  - Auditability: transfers need their own journal (who, when, on what proof)
    and probably an undo path.

## Option B — keep the 409; support-mediated relink + detection

Verify keeps refusing cross-account matches. Add: (1) an admin endpoint that
re-homes a subscription after human verification (writing an audit row), and
(2) telemetry/alerting on `subscription.verify.account_mismatch` so support
reaches out instead of waiting for a ticket. Optional stopgap: suppress
renewal grants when the owning account is deleted, so credits stop pouring
into orphaned wallets in the interim.

- **Pros:** no automated hijack surface; explicit human judgment + audit trail
  on every transfer; small, boring blast radius; buildable in a day.
- **Cons:** paying users stay broken for hours/days until a human acts; support
  load scales with account-recreation volume; the asymmetry itself (SSN
  enriches, verify refuses) remains — only its cost is managed.

## Adjacent notes

- An iOS-side change (generate `appAccountToken` per _account_ instead of per
  install) shrinks the future collision class but heals nothing already in the
  wild, and OTX-based collisions (resubscribe from a new account on the same
  Apple ID) remain either way.
- Play has the same latent shape via `obfuscatedAccountId`
  (`subscription_play_oid_unique`); any decision here should cover both
  providers.

## Decision

Deferred. Revisit when mismatch-409 telemetry shows real volume, or at the next
subscriptions design review — whichever comes first. Option B's detection half
is cheap and useful under either outcome; it is the natural first step.
