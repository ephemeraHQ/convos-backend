# Composio exec — Backend-mediated tool execution (fork Y, worker-courier model)

> **Status**: Active — backend backbone implemented on `louis/composio-exec`
> **Canonical security doc**: [`docs/architecture/composio-security-1pager.md`](../architecture/composio-security-1pager.md) (PR #286)
> **Decision recorded**: fork **(Y) backend-mediates**, identity via **worker-stamped headers** (2026-06-10)
> **Builds on**: PR #294 — backend Composio OAuth flow keyed on `accountId`
> **Created**: 2026-06-08 · **Reframed for fork Y**: 2026-06-09 · **Grounded in repo facts**: 2026-06-10

## The model in one paragraph

The agent container is untrusted; the assistants **worker** (Cloudflare DO running the
outbound proxy) is trusted infrastructure and already holds the only agent API key for
convos-backend (`CONVOS_API_KEY` / `X-Agent-API-Key` — used in production for credits;
the container gets placeholder creds). The agent calls `composio.internal/exec` with only
`{toolkit, action, args}`; the worker builds a **fresh** request to the backend's
`POST /v2/composio/exec`, attaching the key plus identity headers from its **own state**
(never container input). The backend authorizes against the iOS-pushed grant store,
resolves the Composio `connected_account_id` server-side, and makes the Composio call.
The bearer capability and the Composio key never touch the untrusted container; the agent
has no field with which to name another account.

## Ground truth this rests on (verified 2026-06-10)

**convos-assistants**

- The worker proxies all container egress (`outbound.ts`): OpenRouter, Herald, Runtime,
  Browser, private bucket — placeholder creds in the container, injection at the proxy,
  `denyDirectEgress` for bypass attempts. Composio is **today's outlier**: the real
  `COMPOSIO_API_KEY` is forwarded into the container (`hermes-env.ts:191-204`) and
  `connections.mjs` calls `backend.composio.dev` directly with
  `user_id: grant.composioEntityId`, `connected_account_id: grant.composioConnectionId`.
- The worker already authenticates to convos-backend with `X-Agent-API-Key` for the
  credits flow (`convos-backend-client.ts`); **the container never holds that key.**
- Herald webhooks are HMAC-verified by the worker (`herald.ts:31-51`, timing-safe);
  `senderInboxId`/`conversationId` arrive inside the signed body. The instance's
  `heraldConversationId` is pinned at creation and is not agent-supplied.
- `.convos-current-trigger.json` (where `connections.mjs` reads sender/conversation
  today) is **agent-writable → spoofable**. Under this model it stops being
  security-relevant: identity comes from the worker.

**convos-ios**

- At grant time iOS holds everything the grant store needs:
  `(senderId, grantedToInboxId, conversationId, service, composioConnectionId,
composioEntityId)` — and it already **fans out one grant per agent** in the
  conversation (`CloudConnectionGrantRequestSheet.swift:77-97`), matching the
  per-`granteeInboxId` rows exactly.
- iOS already calls `/v2/connections/*` with the SIWE-derived JWT
  (`ConvosAPIClient.swift:790-828`); `POST /v2/connections/grants` slots in beside them,
  called from `CloudConnectionGrantWriter.grantConnection()`.
- Revocation: `CloudConnectionManager.disconnect()` → `ConnectionEventWriter.sendRevoked()`
  is the hook for `DELETE /v2/connections/grants/:id`.

## Threat model (unchanged — do not weaken)

1. **`user_id` is not a secret** — a prompt-injected agent can name any value.
2. **`connected_account_id` is a bearer capability** — Composio does not cross-check it
   against `user_id`. Possession is access, so ownership checks are insufficient and the
   id must never reach the agent.

Invariant: **the agent never holds or names a connection, and cannot name another
account.** Identity comes from the trusted worker; consent comes from the SIWE-issued
grant store; custody (Composio key + bearer ids) stays in the backend.

## Why the worker-courier resolves the old open question

Earlier drafts asked how a trusted `(conversationId, agentInboxId)` reaches the backend
(forward Herald's HMAC for re-verification? per-delivery tokens?). Ground truth makes
this simple: the backend already trusts worker-stamped data on this key for **credits**
(the worker debits specific accountIds). Identity headers are the same trust, same key,
same pattern — no new auth scheme, no HMAC forwarding. Trusting the worker is not an
added assumption: it already runs the proxy and holds every other credential.

## Wire contract

Agent container → worker (`composio.internal`):

```
POST /exec        { toolkit, action, args }
```

Worker → backend (fresh request — **never** forwards container headers):

```
POST /v2/composio/exec
  X-Agent-API-Key:           <CONVOS_API_KEY, worker-only>
  X-Convos-Conversation-Id:  <heraldConversationId pinned at instance creation>
  X-Convos-Agent-Inbox-Id:   <the instance's own inboxId, from worker state>
  body: { toolkit, action, args }
```

Backend (`execHandler`):

1. `agentApiKeyAuth` (worker authentication).
2. `resolveTrustedCaller` reads the two identity headers; absent/oversized → **403
   `trusted_identity_unavailable`** (fail-closed).
3. Grant lookup by `(granteeInboxId = agentInboxId, conversationId, toolkit)`, live only
   (`revokedAt` null, not expired), action within `actions` (empty ⇒ whole toolkit) →
   else **403 `no_grant`**.
4. Multiple distinct owners matched → **409 `ambiguous_grant`** (Tier 2 territory; fail
   closed rather than guess whose data).
5. Resolve `connectedAccountId` (grant-pinned, else from `(ownerAccountId, toolkit)`),
   call `composio.tools.execute(action, { userId: ownerAccountId, arguments,
connectedAccountId })`. The id is never returned to the agent.

## Safety properties

- **Stranger outside the conversation**: no grant row for that conversation → 403 before
  any Composio call. Holding the agent key (i.e., being our worker) doesn't help — the
  worker stamps the _real_ conversation.
- **Agent impersonating another agent**: `granteeInboxId` comes from worker state, not
  the container; grants are per-agent (iOS #812 fan-out).
- **Verb escalation**: action checked against the granted `actions`.
- **Revocation**: checked per call; immediate.
- **Known Tier-1 limit (honest)**: within one conversation, any member can drive the
  agent into a granted toolkit — blast radius is the conversation, matching today's iOS
  semantics (grants fan out to all agents per conversation). Per-sender isolation is
  Tier 2: the worker additionally stamps `X-Convos-Sender-Inbox-Id` from the
  HMAC-verified Herald delivery (needs per-delivery binding — interleaving makes a
  mutable "current sender" racy), and the backend matches it against `ownerInboxId`
  unless the grant is explicitly shared.

## Work plan

**Phase 0 — done**

- #294: backend OAuth flow keyed on `accountId` (+ migration).
- `louis/composio-exec`: `ConnectionGrant` store + migration; grant CRUD under
  `/v2/connections/grants` (SIWE JWT + `requireAccount`; owner stamped from the JWT);
  `POST /v2/composio/exec` with the header-based trusted-caller resolver, fail-closed;
  `ComposioService.execute`/`resolveConnectionId`. Tests: no-DB security boundary
  passing; DB-backed grant/exec cases written (`pnpm test:local`).

**Phase 1 — convos-ios (small)**

- `ConvosAPIClient`: add `POST /v2/connections/grants` + `DELETE
/v2/connections/grants/:id` beside the existing connections methods.
- Call grant-create from `CloudConnectionGrantWriter.grantConnection()` (per agent, as
  it already loops); call revoke from `CloudConnectionManager.disconnect()` /
  `postRevocationSideEffects()`.
- Keep publishing profile metadata for UX; **later** drop
  `composioConnectionId`/`composioEntityId` from it (the agent no longer needs them —
  removing the bearer id from the untrusted wire entirely).

**Phase 2 — convos-assistants (the cutover)**

- `outbound.ts`: add `composio.internal` handler → rewrites to
  `${CONVOS_API_BASE_URL}/v2/composio/exec`, attaches `X-Agent-API-Key` + the two
  identity headers from instance state; **constructs a fresh request** (drop all
  container headers); add `"backend.composio.dev" → denyDirectEgress`.
- `hermes-env.ts`: stop forwarding `COMPOSIO_API_KEY` (placeholder, like OpenRouter).
- `connections.mjs`: execution path calls `composio.internal/exec` with
  `{toolkit, action, args}`; delete the `user_id`/`connected_account_id` plumbing and
  the trigger-file identity dependency.
- Verify the worker has the instance's `agentInboxId` in its own state (it pins
  `heraldConversationId` at creation; confirm the inboxId is alongside or add it).

**Phase 3 — Tier 2 (per-sender isolation)**

- Worker: per-delivery binding of the Herald-verified `senderInboxId` →
  `X-Convos-Sender-Inbox-Id` (a per-delivery capability, not shared mutable state).
- Backend: when present, require `sender == grant.ownerInboxId` or an explicitly shared
  grant; this also resolves `ambiguous_grant` (pick the sender's own connection).
- iOS: explicit shared/private choice on grants if product wants intra-group privacy.

**Open items**

- Nick's sign-off on the backend hop (fork Y) — softened now: Rec 1's proxy pattern is
  _reused_ (the `composio.internal` handler), it just points at our backend instead of
  Composio, and the consent re-check can't live in the worker (it has no grant store).
- Agent-driven OAuth `connect` for non-iOS toolkits: route through the same proxy later;
  out of scope for exec MVP.
- Run the DB-backed suite (`pnpm test:local`) before PR.

## Removed/corrected along the way (audit trail)

- `getIfOwned`-as-authorization — unsafe under the bearer-capability fact.
- Agent passing `ownerInboxId`/`connectionId`/`accountId` — agent names nothing.
- "Retire per-assistant Composio projects" — no such pool exists (single global key).
- deviceId→accountId "identifier alignment" as MVP work — agent path already used
  `inboxId`; #294 fixed the backend OAuth path; `accountId` federation stays v2.
- "Forward Herald HMAC to backend / per-delivery token / scoped sessions" as the Tier-1
  identity mechanism — superseded by worker-stamped headers (same trust as credits).
