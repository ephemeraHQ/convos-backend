# Composio Security Model — MVP

**Author:** Louis
**Audience:** Fabri, Nick, Mike
**Status:** Draft for sign-off (revised after Nick's review)

## TL;DR

There are **two** problems hiding under "Composio security," and the first draft of this doc conflated them:

1. **Key custody** — the agent must never hold the Composio API key.
2. **User scoping** — a compromised agent must not be able to act on another user's connection.

**Key custody belongs in the Assistants outbound proxy, not the backend.** `workers/assistant/.../outbound.ts` already injects credentials for OpenRouter, Herald, the private bucket, and the runtime, and already hard-blocks direct egress (`denyDirectEgress`). Adding a `composio.internal` handler is ~6 mechanical steps in one repo — no new backend endpoint, no extra HTTP hop. Nick is right; this is the cheap, correct home for it.

**OAuth-account isolation is a separate problem that proxying does not solve — in either repo.** The global Composio key is omnipotent across every user in the project, and `user_id` is just the sender's `inboxId`, which is **not a secret**. A prompt-injected agent sends a victim's `inboxId` and the global key acts on their calendar. Injecting the *key* doesn't touch this — the agent still fills in `user_id`/`connected_account_id`. Isolation requires the trusted layer to supply the identity and leave the agent **no field to name another account**. The good news: the trusted anchors to do this already exist (the instance is pinned to one conversation; Herald hands the worker an authentic per-message sender). See Recommendation 2.

## Correcting the record

Two premises in the first draft were wrong. The code:

- **There is no per-assistant Composio project pool.** `COMPOSIO_API_KEY` is a **single global worker env var**, forwarded straight into the agent container (`hermes-env.ts:190-204`). The agent reads `process.env.COMPOSIO_API_KEY` and calls `https://backend.composio.dev` directly (`connections.mjs` `composio()` helper). So "retire per-assistant Composio projects" was retiring something that doesn't exist — and Nick's "Composio creds live in the agent container" is the accurate description of today.
- **The agent already uses `inboxId`, not `deviceId`.** Execution sends `user_id: grant.composioEntityId`, where `composioEntityId = senderId` (the XMTP envelope sender's inboxId, optionally `:label`). The "identifier alignment / switch off deviceId" section of the first draft was solving a break that isn't in this code path.

### Composio terminology + two API facts (the security model hinges on these)

- **`user_id` is Composio's request field, not a Convos identifier.** Today Convos puts the **`inboxId`** in it; the target (per the auth API) is **`accountId`**. Don't read `user_id` as a Convos concept — it's just Composio's parameter name.
- **`connected_account_id` is a bearer capability.** Composio does **not** cross-check that `connected_account_id` belongs to `user_id` (confirmed by Louis). So whoever passes a `connected_account_id` can use that connection *regardless of `user_id`*. Constraining the account identifier alone is **not** sufficient — the `connected_account_id` itself must never reach the agent.
- **Does `tools/execute` resolve a connection from `user_id` + toolkit alone (no `connected_account_id`)?** Open — needed to confirm the agent can omit `connected_account_id` entirely (Decision Q).

## The bug today

For OAuth toolkits the agent runs both `connect` and `execute` through the same global key, so those work. The break is on the **iOS-capability** path (calendar, fitness, etc., the `IOS_CAPABILITY_SERVICES` set): iOS creates the connection in *its* Composio project, drops a `connectionId` into profile metadata, and the agent then tries to execute against the *global agent* key — different project, connection not found.

The consent layer ([convos-ios#796](https://github.com/xmtplabs/convos-ios/pull/796)/[#797](https://github.com/xmtplabs/convos-ios/pull/797), [convos-assistants#1484](https://github.com/xmtplabs/convos-assistants/pull/1484)) is correct under any model below. The break is purely **which project the connection lives in vs. where the agent executes** — i.e. a key-custody/consolidation problem, which the proxy below also fixes by giving us one mediated path.

## Recommendation 1 (key custody): proxy Composio in `outbound.ts`

Agents call `http://composio.internal/api/v3/...`; the outbound handler injects the key and forwards to `backend.composio.dev`. The agent never holds the key, and direct egress to Composio is blocked the same way `openrouter.ai` is.

This is the existing pattern, applied verbatim:

| Step | Change | Precedent |
|---|---|---|
| 1 | Add `composioApiKey` to `CredentialsSchema` (`schemas.ts:182`). | `heraldApiKey` |
| 2 | Define `COMPOSIO_OUTBOUND_HOST = "composio.internal"`. | `HERALD_OUTBOUND_HOST` |
| 3 | Add `proxyComposio()` handler: inject `x-api-key`, forward to upstream. | `proxyHerald` |
| 4 | Wire it in `buildOutboundOverrides` + `outboundByHost`, and add `"backend.composio.dev" → denyDirectEgress`. | OpenRouter + `denyDirectEgress` |
| 5 | Stop forwarding the real key to the container in `buildHermesEnv` (set a placeholder); point `COMPOSIO_BASE_URL` at `http://composio.internal`. | OpenRouter key handling |
| 6 | Swap the agent's `composio()` base URL to the internal host. Two runtimes: `convos-platform` and the mirrored `runtime/hermes/.hermes-dev/...`. | — |

**What this buys:** the load-bearing key-custody invariant, with code that already exists, in one repo, with zero backend dependency and no hot-path round trip. Ship this now.

## Recommendation 2 (isolation): constrain `user_id` in the proxy, in two tiers

The threat in one line: **`connected_account_id` is a bearer capability** (Composio doesn't check it against the account identifier), and the agent fills it in today. So the invariant isn't "constrain the identifier" — it's:

> **The agent must never hold or name a `connected_account_id`.** A trusted layer resolves the connection from a trusted identity (the verified sender's `accountId`) via a grant store keyed by `accountId`, and injects it. The agent sends only `{ toolkit, action, args }`.

Two trusted anchors the agent **cannot forge** make this enforceable:

**Anchor 1 — the conversation is pinned at init.** `Credentials.heraldConversationId` is set when the instance is created (`create-assistant-workflow.ts:539`) and is never agent-supplied.

**Anchor 2 — Herald hands the worker an authentic per-message sender.** The Herald webhook carries `senderInboxId` as a top-level field in the **HMAC-signed** body — `herald.ts:94` verifies the signature, `operations.ts:356` already parses it, envelope shape at `deliver-notify-workflow.test.ts:53`. Herald decrypts XMTP server-side, so this sender is authentic; the worker just doesn't read the field yet. (Contrast `.convos-current-trigger.json`, which a compromised agent **can** forge — `connections.mjs:109`.)

### Tier 1 — conversation-boundary isolation (ship with the proxy)

The trusted layer resolves the connection only from the set of `accountId`s belonging to *this instance's* conversation members (Anchor 1 + the conversation-scoped Herald key, `/v1/conversation/{heraldConversationId}/profiles`). The agent names no connection.

- **DM (the common case): exact per-user isolation** — one member, one possible connection, nothing to spoof.
- **Group: blast radius bounded to conversation members** — never a stranger in another chat.

This closes the cross-conversation leak ("User A asks for User B" where A and B are in different chats) completely, with **no new trusted infrastructure** beyond the grant store.

### Tier 2 — per-sender isolation (closes intra-group escalation)

**This is the "group limit."** Under Tier 1, any member's connection is reachable during *any* turn — so in a group, member B can drive the agent into member A's calendar. The boundary is the conversation, not the person. Closing it needs the connection resolved from the **verified sender's `accountId`** (Anchor 2), default-denying every other member's connection. **Shared grants** (the existing `isShared` path) remain the explicit opt-in when A *wants* the group to use their calendar.

The hard part — and the real reason this is MVP-2: one agent instance serves the whole group with **interleaved** messages, so a mutable "current sender" flag is racy. The robust form is a **per-delivery capability**, not shared state:

- **(a) Per-delivery binding.** The worker resolves the connection for that delivery's verified `senderInboxId → accountId` and binds it to that delivery's work. New plumbing: today's egress context is static at init.
- **(b) Composio scoped sessions** (`tool_router/sessions` / scoped MCP URLs). The worker mints a short-lived session for the verified sender per message; Composio enforces scope and the proxy stops being security-critical. Cleanest **if** sessions support action-level scope (open Decision Q).

**Same rule on the OAuth `connect` path.** The `entity_id`/`accountId` at connect time must be the verified sender, not the trigger-file value — otherwise a malicious agent attaches a victim's connection under the wrong account.

### Open fork: where the grant store + the Composio call live

> **Decided (2026-06-09): fork (Y) backend-mediates.** The backend holds the key and the
> grants and makes the Composio call; the agent calls `Backend.exec(toolkit, action, args)`
> with no connection identifier, so the bearer capability never leaves the backend. Backend
> implementation plan: [`docs/plans/composio-exec-grant-mediation.md`](../plans/composio-exec-grant-mediation.md).

Two secrets, and they need not co-locate: the **Composio project key** (one global secret) and the **per-user `connected_account_id`s** (your backend grant store keyed by `accountId`). But *who calls Composio* is a real decision:

- **(X) Proxy-resolves.** The `outbound.ts` proxy holds the project key (Nick's model) and, per call, resolves the connection from the backend grant store using the verified sender's `accountId`, then calls Composio. Keeps key custody in assistants; adds a backend lookup on the hot path.
- **(Y) Backend-mediates.** Backend holds the key *and* the grants and makes the Composio call itself — the agent calls `Backend.exec(toolkit, action, args)` with no connection identifier. Simplest isolation story (the bearer capability never leaves backend), but it's the mediation layer Nick pushed back on for key custody.

Louis's "store credentials in convos-backend" leans (Y); the earlier "OK for key custody in the proxy" leans (X). **Pick one** — it changes which repo owns the Composio call. Note both keep `connected_account_id` out of the agent; they differ only on where the key lives.

## Identifier alignment / `accountId` — demoted to v2

Because the agent already uses `inboxId` as `user_id`, there's no `deviceId → inboxId` break to fix for MVP. The `accountId` federation story (multi-inbox per user, multi-device, auth-method federation) from Borja's new auth API is still the right long-term unifier, but it's **gated on that API shipping and is not blocking** this work. Moved to v2: when auth lands, switch Composio's `user_id` from `inboxId` to `accountId` and resolve `inboxId → accountId` at the proxy.

## Orthogonal: per-agent grant scoping ([convos-ios#812](https://github.com/xmtplabs/convos-ios/pull/812))

Unchanged from the first draft and still composes cleanly. Per-agent gating lives at the messaging layer keyed on agent `inboxId` (`grantedToInboxId`/`askerInboxId`); the runtime already drops `connection_event`s scoped to another agent (`sdk-client.ts`). That's a different axis from key custody and user scoping; all three land independently.

## Phasing

| Phase | Scope | Effort |
|---|---|---|
| **MVP-1** | `composio.internal` proxy (Rec 1) **+ Tier 1 conversation-boundary isolation** (Rec 2). Key leaves the container; global key becomes per-conversation-scoped; cross-conversation leak closed; DMs get exact per-user isolation. Agent sends only `{toolkit, action, args}`. | one repo, ~one sprint |
| **MVP-2** | **Tier 2 per-sender isolation** (Rec 2, option a or b) — closes intra-group escalation using the worker's verified `senderInboxId`. | scoped after Composio session Q |
| **v2** | `accountId` federation, gated on the new auth API. | not blocking |

## Decision needed

1. **Decided (2026-06-09): fork (Y) backend-mediates.** The backend owns the Composio call and holds both the key and the grants; the agent calls `Backend.exec(toolkit, action, args)`. Consequence: this supersedes **Recommendation 1** (key custody in `outbound.ts`) — under (Y) the agent never calls Composio directly, so there is no key to inject in the proxy, and MVP-1 *does* carry backend work (contrast the "no backend changes" note below, written for the (X) path). Reconfirm with Nick, who preferred (X) to avoid a backend mediation hop.
2. Approve **Tier 1 conversation-boundary isolation** as the MVP (closes the cross-conversation leak; DMs get exact per-user isolation). Owner for the grant store keyed by `accountId` + the agent contract (`{toolkit, action, args}`, no `connected_account_id`).
3. **Resolved (Louis):** Composio does **not** cross-validate `connected_account_id` against the account — so it's a bearer capability and must never reach the agent. The agent contract carries no connection identifier regardless of fork.
4. **Still open — for Nick:**
   - Can `tools/execute` resolve the connection from the account identifier + toolkit alone (so we omit `connected_account_id` entirely)?
   - Do `tool_router/sessions` / scoped MCP URLs support **action-level** scope (`GOOGLECALENDAR_EVENTS_LIST`, not the whole toolkit)? Decides Tier 2 option (a) vs (b).

## Why this aligns with what we already shipped

- iOS PRs (`#796`, `#797`) issue grants tagged `(provider, capability, conversationId)` and post `connection_event` revocations; the runtime already relays revocations into the model (`#1484`). The consent semantics are framework-agnostic and survive this change.
- iOS `#812` (per-agent grant scoping) is an independent axis and lands alongside.
- **No iOS or backend changes for MVP-1.** This is the correction from the first draft: the work is entirely in `convos-assistants`, reusing a proxy pattern that already ships in production for four other upstreams.
