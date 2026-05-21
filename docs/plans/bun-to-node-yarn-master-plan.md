# Bun → Node/Yarn Master Plan

> **Status:** Proposed  
> **Base:** `otr-dev`  
> **Goal:** remove Bun from local dev, CI, Docker, and production runtime with minimal behavior change.

## Decision

This is **not** `yarn` vs `node`:

- **Node.js** = runtime.
- **Yarn** = package manager.

Default target: **Node.js 22 LTS + Yarn 4 via Corepack**.

Guardrails:

- Use Yarn with `node_modules` linker first. No PnP / zero-install during the migration.
- Avoid dependency upgrades unless they unblock the migration.
- Keep API/runtime behavior unchanged.

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
| 1. Toolchain | Pin Node 22, add `packageManager: yarn@...`, add Yarn lock/config, install via Corepack. | `yarn install --immutable` |
| 2. Runtime | Replace Bun TS execution with Node-compatible tooling: `tsx` for dev/scripts/evals; bundled JS for production. | `yarn dev`, `yarn build`, `yarn start` |
| 3. Tests | Move `bun:test` to Vitest; port mocks/preload/setup. | `yarn test` |
| 4. Infra/docs cleanup | Switch CI/Docker/entrypoint/docs from Bun to Node/Yarn; remove Bun pins/lock/config. | CI green + Docker image boots + `/healthcheck` |

These slices can be stacked or split into small PRs. Do not start slice 4 cleanup until slices 1–3 are green.

## Proposed implementation defaults

- **Package manager:** Yarn 4, Corepack-managed, `yarn install --immutable` in CI.
- **Node version:** Node 22 LTS, pinned consistently in `.nvmrc`, `.node-version`, Docker, and GitHub Actions.
- **Dev runtime:** `tsx watch src/index.ts`.
- **One-off TS scripts/evals:** `tsx <script>.ts` through Yarn scripts.
- **Production runtime:** build to `dist/` and run with `node`; keep native deps like `@xmtp/node-bindings` external.
- **Test runner:** Vitest, because it is the closest replacement for `bun:test` ergonomics and mocking.

## Definition of done

- `bun` is not required locally, in CI, in Docker, or in production.
- `bun.lock`, `bunfig.toml`, `.bun-version`, and Bun docs references are removed.
- `yarn install --immutable && yarn check && yarn test` pass.
- Docker build succeeds and the container serves `/healthcheck`.
