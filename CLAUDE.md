# CLAUDE.md

Project conventions for AI agents and humans working in `convos-backend`.

## Client-facing API request contracts are append-only / backwards-compatible

Request schemas under `src/api/v2/**` are a **contract with shipped mobile
clients that we cannot force-update**. Old app builds keep POSTing the request
shapes they were compiled against, for as long as those builds stay installed.
The backend must therefore tolerate every request shape any shipped client
still sends.

Rules:

- **New request fields MUST be optional + server-defaulted.** Never make a
  previously-absent or previously-optional field required.
- **Never tighten an existing field** in a way that rejects a shape older
  clients send (e.g. adding a required discriminator, narrowing an enum,
  raising a `min`).
- If you genuinely must break the contract, **version the endpoint** (new path)
  rather than changing the existing one in place.

Why this matters: PR #290 turned the subscription-verify body into a strict
`z.discriminatedUnion("platform", …)`, which silently 400'd every shipped iOS
build still sending a bare `{ jwsRepresentation }` (no `platform`). PR #329
restored compat by defaulting a missing `platform` to `"apple"` before the
union parse.

**Guard it with a contract test.** When you change a client-facing request
schema, pin every legacy shape with `assertLegacyShapeValidates` (see
`tests/helpers/assertLegacyShapeValidates.ts`) so a future re-tightening fails
CI instead of breaking users. Example:
`tests/subscriptions/verify-body-contract.test.ts`.

## Money / credits: go through the ledger wallet

Any change touching credits, balances, or subscription billing MUST go through
the ledger wallet. `getBalance` is the single source of truth; all balance
movement goes through `@/payments` `consume` / `grant` / `adjust` (subscriptions
via `grantSubscriptionPeriod` / `forfeitSubscriptionPeriod`). Never write
`UserCredits` or `CreditLedger` directly outside `src/payments/ledger/`.

Read the full law before writing money code: **`src/payments/AGENTS.md`**.
Repo-wide agent guidance: `AGENTS.md`.

## PR checklist

- [ ] Any change touching `src/api/v2/**` request schemas: backwards-compatible
      for shipped clients? (old request shapes still validate — add/extend a
      contract test)
- [ ] Any change touching credits/balances: routed through `@/payments`
      (`consume` / `grant` / `adjust`), no direct `UserCredits` / `CreditLedger`
      writes outside `src/payments/ledger/`, idempotency key present
      (see `src/payments/AGENTS.md`)
