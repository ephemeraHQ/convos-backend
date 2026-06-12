# Composio Security Model — 1-Pager

**Author:** Louis
**Audience:** Fabri, Nick, Mike
**Status:** Implemented — on `louis/composio-exec` → `louis/connections-bundles` (backend), `louis/composio-backend-exec` (assistants), `louis/connections-picker-bundles` (iOS); in review, not yet merged to `dev`. The original decision record (fork X/Y, sign-off questions) lives in this PR's history.

## TL;DR

Two problems hide under "Composio security," and **backend-mediated execution** closes both:

1. **Key custody** — the agent must never hold a Composio key. It now holds none: `COMPOSIO_API_KEY` lives only in convos-backend, the agent container gets placeholder creds, and the legacy direct-Composio path in the agent runtime is deleted.
2. **User scoping** — a compromised (prompt-injected) agent must not act on another user's connection, nor exceed what the user consented to. The agent sends only `{toolkit, action, args}` (plus an optional `onBehalfOf` _selector_); identity is stamped by trusted infrastructure, consent is re-checked per call against the grant store, and actions are scoped by **permission bundles**.

## Threat model (the two facts everything rests on)

- **`user_id` is not a secret.** It's Composio's request field; a prompt-injected agent can name any value. Identity must therefore come from a layer the agent cannot influence.
- **`connected_account_id` is a bearer capability.** Composio does not cross-check it against `user_id` — possession is access. It must never reach, or be accepted from, any client or agent.

> Invariant: **the agent never holds a key, never holds or names a connection, and cannot name another account.** Identity comes from the trusted worker; consent comes from the JWT-authenticated grant store; custody (the Composio key + bearer ids) stays in the backend.

## How a tool call flows

```
agent container (untrusted)
  → POST http://composio.internal/exec        { toolkit, action, args, onBehalfOf? }
trusted assistants worker (Cloudflare DO) — proxyComposioExec
  → builds a FRESH request: container headers dropped, body whitelisted
  → POST {backend}/api/v2/composio/exec
      X-Composio-Exec-Key:       dedicated secret (COMPOSIO_EXEC_API_KEY)
      x-convos-conversation-id:  pinned at instance creation — worker state
      x-convos-agent-inbox-id:   the instance's own inbox — worker state
convos-backend — execHandler
  1. composioExecAuth — dedicated key, constant-time compare
  2. resolveTrustedCaller — identity headers absent/oversized → 403 (fail closed)
  3. grant lookup (granteeInboxId, conversationId, toolkit; live, unexpired)
  4. action ∈ union(grant.actions, bundle-resolved actions) — else 403 no_grant
  5. >1 matching owner and no onBehalfOf → 409 ambiguous_grant (fail closed)
  6. connection resolved SERVER-SIDE from (ownerAccountId, toolkit) — never client input
  7. toolkit version pinned; unresolvable → 502 (fail closed)
  8. composio.tools.execute(action, { userId: ownerAccountId, connectedAccountId, version })
```

Defense around the path:

- **Dedicated exec key, not the agent key.** The worker's generic `convos.internal` proxy injects the agent API key for arbitrary backend paths — reusing that key for exec would let a container smuggle an exec call with forged identity headers through the generic proxy. So exec authenticates with a separate secret (`COMPOSIO_EXEC_API_KEY`) that only `proxyComposioExec` sets, and the generic proxy additionally **denies `/api/v2/composio/*`** and **strips `x-convos-*` headers**.
- **Direct egress denied.** `backend.composio.dev` → `denyDirectEgress` in the worker, same as `openrouter.ai`.
- **`onBehalfOf` is a selector, not authority.** It picks among the agent's _already-authorized_ grants ("query Alice's calendar" in a group); naming a member who never granted yields `no_grant` — it cannot widen access.

## Permission bundles (least privilege)

Clients have no Composio action slugs, so action-level consent is expressed as backend-owned **bundles** (human intents like "Events"):

- The catalog (`src/api/v2/connections/bundles.config.ts`) maps `service → bundle → action slugs` and is served via **`GET /v2/connections/services`** (JWT-only) **with slugs stripped** — no Composio slug ever reaches a client.
- Grants carry `{toolkit, serviceVersion, bundleIds}`; the device persists only bundle ids. The backend resolves bundles → actions **at exec time against the current catalog**, so re-mapping actions needs no app release.
- **Fail closed everywhere:** unknown bundle ids are rejected at grant time (400 `unknown_bundle`); a grant whose bundles resolve to nothing (stale/unknown) authorizes nothing at exec (403 `no_grant`) — it never falls back to whole-toolkit. A read-only bundle (`calendar.events.read`) exists precisely to prove a read grant can never write (regression-tested).
- **Transition-only exception:** a legacy grant with _both_ `actions` and `bundleIds` empty still means whole-toolkit (logged). Flipping this to fail-closed is Phase C, once iOS + Android always send `bundleIds` — see "In progress."

## Grant lifecycle

- **Issue:** `POST /v2/connections/grants` (SIWE JWT) — the owner is taken from the JWT, never the body; a caller can only grant access to their own connections. Any `connectionId` in the body is **ignored by design** (bearer capability — accepting one would let a caller pin a victim's connection). One grant per `(owner, grantee, conversation, toolkit)`; grants fan out per agent (iOS #812).
- **Check:** per exec call, live-only (`revokedAt` null, unexpired) — revocation is immediate.
- **Revoke:** by **natural key** (`POST /v2/connections/grants/revoke` with `toolkit [+ conversationId] [+ granteeInboxId]`), so revocation works even when the client lost the grant id; plus `DELETE /grants/:id`. Owner scoped from the JWT.

## Safety properties

| Attack                                     | Outcome                                                                                                                           |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| Stranger outside the conversation          | No grant row → 403 before any Composio call                                                                                       |
| Container forges identity headers          | Worker builds a fresh request; generic proxy strips `x-convos-*` and denies `/api/v2/composio/*`; exec key never in the container |
| Agent impersonates another agent           | `granteeInboxId` comes from worker state, not the container                                                                       |
| Client/agent supplies a `connectionId`     | No API accepts one; resolution is server-side from the owner's own account                                                        |
| Verb escalation (read grant tries a write) | Action must be in the bundle-resolved union → 403 `no_grant`                                                                      |
| Stale/unknown bundle ids                   | 400 `unknown_bundle` at grant; resolve-to-nothing at exec → 403 `no_grant`                                                        |
| Revoked grant                              | Re-checked per call; natural-key revoke needs no stored id                                                                        |
| Two members granted the same toolkit       | 409 `ambiguous_grant` unless `onBehalfOf` names one                                                                               |

## Known limits & in progress

- **Tier-1 boundary (honest limit):** within one conversation, any member can drive the agent into a granted toolkit — the blast radius is the conversation, matching the iOS consent semantics. **Tier 2 per-sender isolation** (worker stamps the HMAC-verified Herald sender per delivery; backend matches it against `ownerInboxId` unless the grant is explicitly shared) is designed but **not built**.
- **PR #294 — Composio connections scoped to `accountId`** (+ one-time move migration): **in progress** (open). Exec already keys Composio's `user_id` to the stable `ownerAccountId`.
- **Phase C — fail-closed flip for legacy grants** (drop the whole-toolkit default for empty/empty grants): **in progress**, gated on iOS + Android always sending `bundleIds`.
- **Toolkit version pinning** currently pins the newest published version at call time (fail-closed when unresolvable); pinning to a vetted version is being refined: **in progress**.
- **`accountId` federation** (multi-inbox/multi-device) stays gated on the new auth API — unchanged, v2.

## Pointers

- Bundles contract + catalog decisions: `docs/plans/connections-bundles-backend.md` (on `louis/connections-bundles`, with JSON Schemas under `docs/schemas/`).
- Implementation plan (historical, see its status banner for corrections): [`docs/plans/composio-exec-grant-mediation.md`](../plans/composio-exec-grant-mediation.md).
