# Single-Ledger Wallet Migration — Build Plan (n=1)

_Repo: `/Users/lourou/dev/convos/convos-backend` · branch `otr-dev` · 2026-06-23._
_For Louis + Borja, this afternoon, ONE PR. Sized for ONE live subscriber — deliberately strips the v2 cutover state machine, dual-write, backfill-safety, consume-freeze, and rolling-deploy gating. Keep only the model + the cheap-correct safeguards. No co-author footers._

---

## 0. Target model (3 lines)

1. **One wallet.** `UserCredits.balance` (+ `CreditLedger` rows) is the only spendable truth. Every read returns it — no `tierGrant − consumes` derivation, no bimodal switch on `isEntitledSubscription`.
2. **Subscriptions are money-in/money-out on that wallet.** Subscribe + each renewal write a real `grant` row (idempotent per `{subscriptionId, periodStart}`); expiry/refund writes a bounded `subscription_forfeit` adjustment that removes only the _unused subscription_ portion.
3. **One debit path.** Subscriber consume drops the `recordOnly` special case and decrements the wallet exactly like free-tier.

---

## 1. What changes (grounded file:line)

### 1a. Grant — materialize on subscribe + every renewal

Today the subscription verify/notification paths write **no credit rows** (allotment is derived at read time, `tier-config.ts:21-30` comment confirms). Change: write a real `grant` ledger row into the wallet at each window advance, reusing the existing `grant()` path (`src/payments/index.ts:85`).

- New helper `grantSubscriptionPeriod(tx, { subscription, periodStart })` — wraps `grant()`/`applyDeltaWithTx` (`ledger/repository.ts:190`, takes the `UserCredits` row lock):
  - `credits = tierGrant(requireSubscriptionTier(sub.tier), sub.period).perPeriod` (`tier-config.ts:56`).
  - `kind: "subscription_grant"`, `scope: "grant"`.
  - **Idempotent key** `sub_grant:{subscription.id}:{periodStartEpoch}` — one row per (sub, period). A webhook retry, an Apple S2S `DID_RENEW` + iOS `/verify` racing the same period, or a re-verify all resolve to the same key → `applyDelta` returns `replayed:true` on P2002 (`index.ts:117-133,154-180`). **Cheap, keep it.** Key on the internal stable `subscription.id` (`schema.prisma:371`), NOT a provider token (Play rotates `purchaseToken`).
- **Call sites** (inside the existing tx, both providers):
  - `upsertFromVerify` (`repository.ts:351-409`): on `create` (initial) and on the non-stale update branch (`repository.ts:386-395`, `!isStaleVerify`) — covers Apple + Google `/verify`.
  - `applyNotification` (`repository.ts:515-546`): right after `tx.subscription.update` (`:540`), for Apple `SUBSCRIBED`/`DID_RENEW` and Play `purchased`/`renewed`. Guard the grant on "the update advanced `currentPeriodStart`" so only a real new period grants.
- Add `Subscription.lastGrantedPeriodStart DateTime?` (nullable) as the "already granted this period?" anchor; set it in the same tx after a successful grant. (Cheap; lets the optional cron know what's ungranted without scanning the ledger.)

### 1b. Forfeit — bounded clawback on expiry/refund

On expiry/refund, write ONE `subscription_forfeit` adjustment via `adjust()` (`index.ts:189`) or a forfeit-kind grant of negative delta:

```
periodGrant    = Σ subscription_grant deltas for (sub.id, current period)   # what we put in
periodConsumes = Σ |consume deltas| since currentPeriodStart                # what was spent
unusedSub      = max(0, periodGrant − periodConsumes)
forfeitDelta   = − min(walletBalance, unusedSub)        # CLAMP — never wipes admin/promo/signup
```

- **One-line clamp keeps it bounded** — `min(walletBalance, unusedSub)` guarantees the forfeit never drives the wallet below the non-subscription credits sharing it. **Keep it.** You MUST track period granted-vs-consumed to know "unused" — `periodGrant` from the grant row(s), `periodConsumes` from `sumPeriodConsumes(accountId, currentPeriodStart)` (`spendable.ts:12`).
- `scope: "subscription_forfeit"`, key `sub_forfeit:{subscription.id}:{periodStartEpoch}` (one forfeit/period).
- **Triggers:** Apple `EXPIRED`/`GRACE_PERIOD_EXPIRED`/`REFUND`/`REVOKE` (`notification-mapping.ts:90-104`); Play `expired`/`revoked` (`google-play/notification-mapping.ts:92-100`). Wire transactionally into `applyNotification`. **Cancel (auto-renew off, period still active) → no action** (`DID_CHANGE_RENEWAL_STATUS` just flips `willRenew`, `notification-mapping.ts:106-110`).

### 1c. Reads — remove the derived/bimodal path

- `getSpendableBalance` (`spendable.ts:29-46`) → collapse to `return getBalance(accountId)`. Delete the `findCurrentByAccountId`/`isEntitledSubscription`/`tierGrant − used` branch and its imports.
- `isSpendAllowed` (`spendable.ts:48`) already calls `getSpendableBalance` → inherits the wallet read with no edit. Callers `credits-by-id-get.ts` (agent gate) and `account-view-get.ts` inherit it too.
- **Drop `recordOnly`:** `recordConsume` (`spendable.ts:51-78`) currently special-cases entitled subscribers onto a no-mutation `applyDelta({ recordOnly:true })`. Make `recordConsume` just call `consume()` (`index.ts:41`) for everyone — one real, floor-checked decrement. The only caller is `credits-transactions-post.ts:63`. If no other `recordOnly:true` caller remains (grep confirms only this), drop the `recordOnly` flag from `applyDeltaWithTx` too.
- `credits-get.ts` (`:37-92`): compute `balance` from `getBalance`; keep display fields — `monthlyGrant` = period grant amount, `monthlyGrantUsed = clamp(monthlyGrant − balance, 0, monthlyGrant)`, `periodLabel`, `nextRefreshAt = currentPeriodEnd`. **JSON keys byte-identical** (iOS contract unchanged: `{balance, monthlyGrant, monthlyGrantUsed, nextRefreshAt, periodLabel}`).

---

## 2. Reuse vs drop from the overnight stack

**REUSE:**

- **Reconcile cron** (`louis/credits-reconcile-cron:src/subscriptions/reconcile/service.ts`) — provider-grounded entitlement-window refresher. As a single-ledger plan it becomes the **safety net** that (a) fires the missed-renewal grant and (b) catches missed expiries → forfeit. **At n=1 it is OPTIONAL** (you'll notice a stuck sub manually), but it's cheap and already written — recommended to keep. It writes window/status today; if you adopt it, hook the same grant/forfeit calls into its per-sub body. Note: that branch's cron writes ZERO credit rows by design — fine to ship its window-refresh as-is and let `applyNotification`/verify do the granting.
- **Entitlement/grace state handling** from `louis/credits-entitlement-grace` — the `effectiveSubscriptionStatus` grace logic (`status.ts:48-86`) and the **boot-validate of `PAYMENTS_GRANT_PLUS_MONTHLY`** (that branch adds it to `loadConfig`, `config.ts`, + `grant-plus-monthly-config.unit.test.ts`). Pull the boot-validate in (see §4).

**DROP:**

- B1's derived→raw spend-allocation logic (`louis/credits-entitlement-grace` adds ~335 lines to `spendable.ts` for the hybrid derived+raw model) — **moot with one wallet**. Take its config/status/test deltas, not its `spendable.ts` derivation.
- The entire v2 cutover machinery: `CreditsCutover` state table, `legacy_derived→backfilling→read_raw→consume_raw`, consume-freeze, parity gate, dual-write phase, per-instance rolling-deploy branching. **All of it was for many live subs.**

---

## 3. The n=1 migration

We have ONE active subscriber. Two equally-fine options — pick the lazy one:

- **Option A (do nothing, recommended):** ship the PR; the subscriber's wallet re-grants automatically on their **next renewal** (or next `/verify`). Until then their wallet shows whatever raw credits they have. If that's a few days, fine; if it would leave them at ~0, use B.
- **Option B (one-shot materialize):** run a tiny one-liner once after deploy — a single `grant()` with key `sub_grant:{sub.id}:{currentPeriodStartEpoch}` and `credits = tierGrant(...).perPeriod − min(used, perPeriod)` (clamp by already-spent this period so you don't over-credit). Idempotent: the renewal grant later will no-op on the same key. Or just an admin grant row in the existing admin portal.

**Explicitly NOT doing:** no cutover state machine, no dual-write/verify, no backfill-safety harness, no consume-freeze. Those exist to protect _many concurrent_ subscribers mid-migration; with n=1 the blast radius is one row you can inspect by hand.

---

## 4. Cheap-correct safeguards to keep (NOT scale machinery)

- [x] **Idempotent grant key** `sub_grant:{sub.id}:{periodStartEpoch}` — prevents double-grant on webhook retry / S2S+verify race. (§1a)
- [x] **Bounded forfeit** `−min(walletBalance, unusedSub)` — never wipes admin/promo/signup credits; clamps at 0. (§1b)
- [x] **Boot-validate `PAYMENTS_GRANT_PLUS_MONTHLY`** — add to `loadConfig` so a bad value fails at boot, not on first subscriber read. Already done on `louis/credits-entitlement-grace` (`config.ts` + `grant-plus-monthly-config.unit.test.ts`) — cherry-pick that hunk.
- [x] **Register grant kinds** — add `subscription_grant` + `subscription_forfeit` to `GrantKindIdSchema` (`types.ts:3`) and `subscription_forfeit` to `LedgerScopeSchema` (`types.ts:10`); seed `GrantKind` rows in the migration (mirror `20260515120000_payments_credits_foundation/migration.sql:66`, `ON CONFLICT DO NOTHING`). Without this the grant write fails Zod (`index.ts:97`).

---

## 5. Test plan (the money paths)

1. **Grant materializes + idempotent:** subscribe → one `subscription_grant` row, wallet += perPeriod. Replay the same webhook / S2S+verify same period → still one row, `replayed:true`, balance unchanged.
2. **Renewal grants the new period:** advance `currentPeriodStart` → new `sub_grant` row (different key), wallet += perPeriod again; `lastGrantedPeriodStart` updated.
3. **Unified consume:** subscriber consume decrements the wallet (real, floor-checked) — assert admin credits + subscription credits are spent uniformly from the one balance; no `recordOnly` no-op.
4. **Bounded forfeit:** grant perPeriod, consume part, grant admin credits on top, then expire → forfeit removes only `min(walletBalance, unusedSub)`; **admin credits survive**; balance never goes below 0 or below the admin portion.
5. **Refund/revoke = immediate bounded forfeit** (Apple `REFUND`/`REVOKE`, Play `revoked`); cancel-while-active → NO forfeit (credits stay to period end).
6. **Boot-validate:** missing/bad `PAYMENTS_GRANT_PLUS_MONTHLY` throws at `loadConfig`, not at read.

(Reuse the existing test deltas on `louis/credits-entitlement-grace`: `tests/subscriptions/{notification-mapping,repository,status}.test.ts`, `tests/credits/spendable.integration.test.ts`, `grant-plus-monthly-config.unit.test.ts` — adapt assertions from derived-balance to wallet-balance.)

---

## 6. Files to touch + PR shape

**Schema/config**

- `prisma/schema.prisma` — add `Subscription.lastGrantedPeriodStart DateTime?`; new migration seeding the two `GrantKind` rows.
- `src/payments/types.ts` — `GrantKindIdSchema` += `subscription_grant`, `subscription_forfeit`; `LedgerScopeSchema` += `subscription_forfeit`.
- `src/payments/credits/config.ts` — boot-validate `PAYMENTS_GRANT_PLUS_MONTHLY` (cherry-pick from `louis/credits-entitlement-grace`).

**Grant / forfeit**

- New `src/subscriptions/grants.ts` — `grantSubscriptionPeriod()` + `forfeitSubscriptionPeriod()` helpers + key builders.
- `src/subscriptions/repository.ts` — call grant in `upsertFromVerify` (`:386-395`) and `applyNotification` (`:540`); call forfeit in `applyNotification` for expired/revoked; set `lastGrantedPeriodStart`.

**Reads (remove derivation)**

- `src/payments/spendable.ts` — `getSpendableBalance` → `getBalance`; `recordConsume` → `consume()`; drop derived imports + `recordOnly`.
- `src/payments/ledger/repository.ts` — drop `recordOnly` flag if no other caller.
- `src/api/v2/accounts/handlers/credits-get.ts` — `balance` from `getBalance`; keep display fields + JSON keys.

**(Optional) safety-net cron**

- `src/subscriptions/reconcile/service.ts` (+ router/handler/mount) from `louis/credits-reconcile-cron` — recommended but not required at n=1.

**Tests** — adapt the entitlement-grace + reconcile-cron test deltas to wallet semantics.

**PR shape:** single PR off `otr-dev`. Suggested commit order: (1) schema migration + grant-kind enum + boot-validate; (2) grant/forfeit helpers + wire into repository; (3) collapse reads to wallet + drop `recordOnly`; (4) tests; (5) optional reconcile cron. Two engineers: Louis takes grant/forfeit + repository wiring; Borja takes the read collapse + `credits-get` + tests (or split by commit above). One-shot materialize the single sub post-merge (§3 Option B) if Option A would leave them at ~0.
