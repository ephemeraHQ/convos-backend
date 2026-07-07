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

`getSpendableBalance` / `isSpendAllowed` / `recordConsume`
(`src/payments/spendable.ts`) are thin aliases to `getBalance` / the floor check
/ `consume`, kept so the agent gate and admin view keep stable imports. Prefer
the `@/payments` names in new code.

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
`^[A-Za-z0-9_-]{1,255}$` — underscore separators, **not** colon. Replays are
validated field-by-field: the same key with a different payload throws
`IdempotencyMismatchError` (surfaced as HTTP 409), it does not silently double-move.

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

1. Add, debit, or admin-adjust? Use `grant`, `consume`, or `adjust`. Do not
   invent a new mutation path.
2. New systematic source of granted credits? Define a `GrantKind` (migration +
   seed) and pass its id to `grant`. Don't overload `manual` for a systematic
   source.
3. Needs atomicity with other DB writes (e.g. a subscription row)? Take a tx and
   call `applyDeltaWithTx(tx, …)`. Otherwise the top-level `grant` / `consume` /
   `adjust` already open their own transaction.
4. Provide a deterministic idempotency key (charset above). One logical event =
   one key.
5. Test balance movement, idempotent replay (same key → no double move), and
   floor behavior on debits.

## Deeper reference

`docs/plans/credits-single-ledger-migration.md` — the single-ledger model, the
`sub_grant` / `sub_forfeit` design, and the Option-A migration tradeoff in full.
