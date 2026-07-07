# AGENTS.md

Repo-wide guidance for agents and humans working in `convos-backend`. Start
here, then read the domain-specific `AGENTS.md` nearest the code you are
changing.

## Domain guides

- **Money / credits / balances / subscription billing → [`src/payments/AGENTS.md`](src/payments/AGENTS.md).**
  MANDATORY before touching any credits, wallet, or subscription-billing code.
  The one rule up front: all balance movement goes through the ledger wallet
  (`@/payments` `consume` / `grant` / `adjust`); `getBalance` is the single
  source of truth; never write `UserCredits` / `CreditLedger` directly outside
  `src/payments/ledger/`. Everything else — entry points, idempotency, units —
  is in that file.

## Client-facing API request contracts

Request schemas under `src/api/v2/**` are an append-only contract with shipped
mobile clients we cannot force-update: new fields optional + server-defaulted,
never tighten an existing shape, version the path if you must break it. Full
rule and rationale in [`CLAUDE.md`](CLAUDE.md).
