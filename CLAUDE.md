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

## End-to-End Local Testing

Pointing the iOS app at this backend works, and the two settings that decide
whether auth succeeds are not the ones `.env.example` ships.

**SIWE must match what the app signs.** Local and dev iOS builds sign for
`dev.convos.org`, so the backend needs:

```
SIWE_DOMAIN=dev.convos.org
SIWE_URI=https://dev.convos.org
SIWE_ALLOWED_CHAIN_IDS=1
NONCE_HMAC_SECRET=<any stable secret>
```

Leaving the `.env.example` defaults produces a failure that reads as a cookie
problem rather than a config one: `/auth/nonce` returns 200, then `/auth/token`
returns 401 "Invalid nonce".

**A physical device needs HTTPS.** Expose this backend through ngrok and give
the app that URL as `CONVOS_API_BASE_URL` — `localhost` means the phone itself,
and a LAN IP has no certificate. The simulator can use either. `trust proxy`
has to be on for the nonce cookie to survive the tunnel.

The app talks only to this service; the assistants Worker sits behind it and is
never contacted directly. See `CLAUDE.md` in convos-ios for the app-side
configuration, and `AGENTS.md` in convos-assistants for the Worker side.

## PR checklist

- [ ] Any change touching `src/api/v2/**` request schemas: backwards-compatible
      for shipped clients? (old request shapes still validate — add/extend a
      contract test)
- [ ] Any change touching credits/balances: routed through `@/payments`
      (`consume` / `grant` / `adjust`), no direct `UserCredits` / `CreditLedger`
      writes outside `src/payments/ledger/`, idempotency key present
      (see `src/payments/AGENTS.md`)
