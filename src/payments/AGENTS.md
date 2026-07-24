# Money & Credits — how to work in this domain

This is the law for any code that touches credits, balances, or subscription
billing. Read it before writing or reviewing money code. Ledger changes move
real user balances and are hard to reverse — treat this surface with care.

## The one invariant

`getBalance(accountId)` — which reads `UserCredits.balance` — is the single
source of truth for an account's spendable credits. It is the **same wallet for
everyone**: subscribers and non-subscribers read the same number.

`UserCredits.balance` is a materialized running balance. `CreditLedger` is the
append-only journal. They are kept in lockstep by exactly **one** code path:

    applyDelta / applyDeltaWithTx   (src/payments/ledger/repository.ts)

which, in a single transaction, writes the `CreditLedger` row **and** updates
`UserCredits.balance`. Nothing else may move a balance. Move the balance any
other way and the journal and the materialized balance diverge — the invariant
is broken and every downstream number (spend gate, admin view, reconciliation)
becomes a lie.

## Sanctioned entry points — the ONLY way to touch money

**Read** (`@/payments`):

| Function                                           | Purpose                                                                                                              |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `getBalance(accountId)`                            | Spendable balance — the source of truth.                                                                             |
| `isAllowed(accountId)`                             | Advisory UX gate (`balance >= reservedMaxTurnCredits`). NOT authorization — `consume` enforces the floor atomically. |
| `getHistory(accountId, limit?, cursor?)`           | Ledger rows, descending, cursor-paginated.                                                                           |
| `getBucketedConsumption(accountId, since, bucket)` | Consume sums per UTC day/week/month.                                                                                 |

**Mutate** (`@/payments`):

| Function        | Purpose                                                                                   |
| --------------- | ----------------------------------------------------------------------------------------- |
| `consume(args)` | Debit for model/agent spend. Converts `usdCostMicros`→credits, floor-checked, idempotent. |
| `grant(args)`   | Add credits. Validates the `GrantKind` is active in-tx, idempotent.                       |
| `adjust(args)`  | Manual +/- adjustment (admin). Floor-checked when negative, idempotent.                   |

**Subscriptions only** (`src/subscriptions/grants.ts`) — materialize entitlement
into the wallet:

| Function                           | Purpose                                                                          |
| ---------------------------------- | -------------------------------------------------------------------------------- |
| `grantSubscriptionPeriod(tx, …)`   | Writes a real `sub_grant` credit row on verify/renewal.                          |
| `forfeitSubscriptionPeriod(tx, …)` | Bounded `sub_forfeit` clawback on expiry — never wipes non-subscription credits. |

Both run `applyDeltaWithTx` inside the caller's transaction, so the subscription
row update and the ledger row commit or roll back together.

**Account-deletion interactions.** `applyDeltaWithTx` takes the Account lock
(`requireLiveAccount`, `FOR KEY SHARE`) before the `UserCredits` row lock:
every account-linked writer acquires its Account lock first, so the deletion
teardown (Account `FOR UPDATE` first) can never deadlock against a ledger
writer, and a ledger write racing a deletion surfaces as
`AccountNotLiveError` instead of an FK violation. The teardown itself removes
the wallet through `deleteWalletForAccountWithTx`
(`src/payments/ledger/repository.ts`) — the one sanctioned way to delete
`CreditLedger` / `UserCredits` rows, kept inside the ledger module so the
single-writer law survives account deletion.

`getSpendableBalance` / `isSpendAllowed` / `recordConsume`
(`src/payments/spendable.ts`) are thin aliases to `getBalance` / the floor check
/ `consume`, kept so the agent gate and admin view keep stable imports. Prefer
the `@/payments` names in new code.

A few existing internal flows write through the low-level primitives directly
rather than the `consume`/`grant`/`adjust` façade: the signup bonus
(`grantSignupBonusWithTx`, `src/payments/signup-bonus.ts`) and daily refill
(`src/payments/daily-refill/service.ts`) call `applyDeltaWithTx` / `applyDelta`
with their own `GrantKind`, because they must commit inside a wider transaction
or a batch loop. They are precedent, not violations — a new tx-scoped flow
follows the same pattern (see the checklist below), and still lives inside
`src/payments`.

## Hard rules — do NOT

- **Do NOT write `UserCredits` or `CreditLedger` directly** (`prisma.userCredits.update`,
  `prisma.creditLedger.create`, raw SQL) anywhere outside `src/payments/ledger/`.
  Read-only queries for reporting are fine; mutations are not.
- **Do NOT derive a balance.** There is no `tierGrant − periodConsumes`, no
  bimodal switch on `isEntitledSubscription`. One wallet, one number.
- **Do NOT re-add `recordOnly`** or any subscriber-only no-mutation debit path.
  It was removed on purpose (#324): subscriber period credits live in the wallet,
  so there is one debit path for everyone.
- **Do NOT re-add a materialize CLI** to paper over the Option-A `n=1` window (an
  entitled subscriber whose current period was not yet materialized, having
  already drained their raw wallet, can transiently hit `InsufficientBalanceError`;
  the next verify/renewal materializes the period and fixes it). This is
  documented and accepted — see the migration doc.
- **Do NOT call a money mutation without an idempotency key.**

## Idempotency keys

Every ledger mutation carries an idempotency key, charset
`^[A-Za-z0-9_-]{1,255}$` — underscore separators, **not** colon.

The top-level entry points (`consume` / `grant` / `adjust`) validate replays
field-by-field: the same key with a different payload throws
`IdempotencyMismatchError` (HTTP 409), and a matching replay returns the prior
result instead of double-moving. That guarantee lives in `applyDelta`, **not**
in `applyDeltaWithTx`. If you call `applyDeltaWithTx` directly (as the
subscription helpers do), you own the idempotency pre-check — look up the prior
row first (see `grantSubscriptionPeriod`'s `findLedgerRow` short-circuit), or a
duplicate key surfaces as a raw Prisma `P2002`, not a 409.

Server-generated key shapes: `signup_bonus_<accountId>`,
`daily_refill_<accountId>_<YYYY-MM-DD>`, and per-period `sub_grant` / `sub_forfeit`
keys. The `consume` key is client-supplied by the assistants harness
(`consume_<instanceId>_<generationId>`).

## Units

- Credits are `BigInt` end to end (`UserCredits.balance`, `CreditLedger.delta`).
- `usdCostMicros` on a consume row is the **raw provider cost** (what the model
  call cost), pre-markup. Credits debited = `usdToCredits(usdCostMicros)` =
  `usdCostMicros × markupRate × creditsPerDollar`, ceil-rounded per row
  (`src/payments/credits/pricing.ts`). So summing `usdCostMicros` gives cost of
  goods, not revenue and not what users were charged.
- `consume` is USD-cost-denominated; `grant` / `adjust` are credit-denominated
  (no pricing snapshot needed — the delta is the record).

## Adding a new money flow — checklist

1. Add, debit, or admin-adjust? Use `grant`, `consume`, or `adjust`.
   Subscription billing? Use `grantSubscriptionPeriod` / `forfeitSubscriptionPeriod`.
   Do not invent a new mutation path.
2. New systematic source of granted credits? Define a `GrantKind` (migration +
   seed) and pass its id to `grant`. Don't overload `manual` for a systematic
   source.
3. Needs atomicity with other DB writes (e.g. a subscription row)? Take a tx and
   call `applyDeltaWithTx(tx, …)`. Otherwise the top-level `grant` / `consume` /
   `adjust` already open their own transaction. Caveat: `applyDeltaWithTx` /
   `applyDelta` do NOT enforce the `GrantKind.active` gate that `grant()` does —
   if your credit source uses a `GrantKind` that can be deactivated, either go
   through `grant()` or replicate the active-check in your tx.
4. Provide a deterministic idempotency key (charset above). One logical event =
   one key.
5. Test balance movement, idempotent replay (same key → no double move), and
   floor behavior on debits.
6. Did the change alter the balance model, add a `GrantKind` / `LedgerReason`,
   or touch entitlement math (not just add a flow)? Update the credits admin
   page too — see the next section.

## The credits admin page mirrors this domain — keep it in sync

`src/api/v2/credits-admin/` is a live read/write mirror of the ledger: it shows
`getBalance`, the `CreditLedger` history, per-period consume sums, and the
subscription entitlement view, and it mutates through `grant` / `adjust`. It is
**not** generated — it hard-codes the current balance model, so it drifts
silently when the model changes underneath it.

Any change to how credits are stored, computed, or displayed MUST carry a
matching update to the admin page, or its numbers become a lie:

- New `GrantKind` / `LedgerReason` → surface it in the ledger view.
- Changed meaning of `getBalance` / spendable, or a removed derived path →
  update the balance cards and their labels. (The Option-B → single-ledger
  migration left "Spendable (derived)" and "Raw parked balance" cards rendering
  identical numbers precisely because this step was skipped.)
- Changed subscription entitlement math (tier grant, period, forfeit) → update
  the subscription view and per-period figures.

Treat the admin page as part of the blast radius of any money-model change, the
same as any downstream consumer.

## Deeper reference

`docs/plans/credits-single-ledger-migration.md` — the single-ledger model, the
`sub_grant` / `sub_forfeit` design, and the Option-A migration tradeoff in full.
