# Bun → Node/pnpm Master Plan

> **Status:** Proposed  
> **Base:** `otr-dev`  
> **Goal:** remove Bun from local dev, CI, Docker, and production runtime with minimal behavior change.

## Decision

This is **not** `pnpm` vs `node`:

- **Node.js** = runtime.
- **pnpm** = package manager.

Default target: **Node.js 22 LTS + pnpm 10 via Corepack**.

Why pnpm over Yarn here: fast, strict, widely used, boring in CI/Docker, and no Yarn Berry/PnP footguns. Use a committed `pnpm-lock.yaml`; do not use zero-install.

Guardrails:

- Avoid dependency upgrades unless they unblock the migration.
- Keep API/runtime behavior unchanged.
- Fix undeclared dependency issues surfaced by pnpm instead of relaxing pnpm.

## Current Bun surface

- `package.json` scripts use `bun build`, `bun run`, `bun test`, `bun --watch`.
- `bun.lock`, `bunfig.toml`, `.bun-version` pin Bun.
- Docker installs Bun and `dev/entrypoint.sh` invokes Bun.
- CI uses `oven-sh/setup-bun` and `bun ...` commands.
- Tests import from `bun:test` and use Bun mocks/preload behavior.
- Docs/scripts/eval docs reference Bun commands.

No runtime `src/` Bun API dependency was found in the initial scan; the largest code migration is the test runner.

## Migration shape

| Slice | Change | Gate |
| --- | --- | --- |
| 1. Toolchain | Pin Node 22, add `packageManager: pnpm@...`, add `pnpm-lock.yaml`, install via Corepack. | `pnpm install --frozen-lockfile` |
| 2. Runtime | Replace Bun TS execution with Node-compatible tooling: `tsx` for dev/scripts/evals; bundled JS for production. | `pnpm dev`, `pnpm build`, `pnpm start` |
| 3. Tests | Move `bun:test` to Vitest; port mocks/preload/setup. | `pnpm test` |
| 4. Infra/docs cleanup | Switch CI/Docker/entrypoint/docs from Bun to Node/pnpm; remove Bun pins/lock/config. | CI green + Docker image boots + `/healthcheck` |

These slices can be stacked or split into small PRs. Do not start slice 4 cleanup until slices 1–3 are green.

## Proposed implementation defaults

- **Package manager:** pnpm 10, Corepack-managed, `pnpm install --frozen-lockfile` in CI.
- **Node version:** Node 22 LTS, pinned consistently in `.nvmrc`, `.node-version`, Docker, and GitHub Actions.
- **Dev runtime:** `tsx watch src/index.ts`.
- **One-off TS scripts/evals:** `tsx <script>.ts` through package scripts.
- **Production runtime:** bundle `src/index.ts` to `dist/` with a Node-targeted bundler, then run `node dist/index.js`; keep native deps like `@xmtp/node-bindings` external.
- **Test runner:** Vitest, because it is the closest replacement for `bun:test` ergonomics and mocking.

## Definition of done

- `bun` is not required locally, in CI, in Docker, or in production.
- `bun.lock`, `bunfig.toml`, `.bun-version`, and Bun docs references are removed.
- `pnpm install --frozen-lockfile && pnpm check && pnpm test` pass.
- Docker build succeeds and the container serves `/healthcheck`.
