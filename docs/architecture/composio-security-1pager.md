# Composio Security Model — MVP

**Author:** Louis
**Audience:** Fabri, Nick, Mike
**Status:** Draft for sign-off

## TL;DR

Convos Backend owns all Composio connections and exposes a narrow per-call API to agents. Retire the per-assistant Composio projects in the Assistants pool config. Per-user projects can come in v2; not blocking MVP.

## The bug today

iOS authorizes Google Calendar via Convos Backend's Composio project. The connection lands there. The user's profile metadata gets a `connectionId`. The agent then tries to invoke the action via *its own* per-assistant Composio project — and finds nothing, because the connection lives in a different project.

The capability-request consent layer ([convos-ios#796](https://github.com/xmtplabs/convos-ios/pull/796) / [#797](https://github.com/xmtplabs/convos-ios/pull/797), [convos-assistants#1484](https://github.com/xmtplabs/convos-assistants/pull/1484)) is correct under any security model below. The break is purely **where the agent invokes the toolkit**.

## Recommendation: Backend mediates Composio access

Agents call **Convos Backend → Composio**, never Composio directly. Backend already holds the only Composio project key; we keep it that way and expose a narrow API to agents.

```
iOS  → Backend.connect(toolkit)              # OAuth, stores connectionId in profile metadata
                ↓
Agent → Backend.exec(user, toolkit, action, args)
                ↓ (re-validates the iOS-issued capability grant)
        Backend → Composio
```

Per-call scope is `(user, toolkit, action, connectionId)` — the same tuple iOS already gates via the picker. Backend re-checks the capability grant before forwarding (defense-in-depth: a misbehaving agent can't escalate verbs).

## Phasing

| Phase | Scope | Effort |
|---|---|---|
| **MVP-1** | Convos Backend exposes `POST /v2/composio/exec` (thin proxy for `tools/execute`) **plus identifier alignment** (see below). Agent call stack becomes `connections.mjs exec → Backend → Composio`. **Per-assistant Composio projects retired** — that's the source of the current bug. | one sprint |
| **MVP-2** | Replace proxy with Composio `tool_router/sessions` or scoped MCP URLs. Same agent contract, lower Backend hot-path cost. | when session APIs prove out |
| **v2** | Project-per-user on Backend for stronger blast-radius isolation. | not blocking |

The agent contract stays the same across phases — only Backend internals change.

## Identifier alignment (the missing link)

Today there are four silos with no link between them:
- **device/auth:** `deviceId` (iOS `identifierForVendor`, encoded in the JWT).
- **messaging:** `inboxId` (XMTP — sender of conversations).
- **Composio API:** `userId`, populated today with `deviceId`.
- **payments foundations:** `inboxId`.

The agent only ever has `inboxId` (from the XMTP envelope sender); the Backend only ever has `deviceId` (from the JWT). There's no mapping anywhere — JWT has no inboxId field, no Backend table reconciles them. Today this works only because iOS handles both sides of its own flow; the moment an agent is the caller, the link breaks.

**Recommended fix: switch Composio's `userId` to `accountId` from the new auth API.**

The new auth API ([Borja's design](https://xmtp-labs.slack.com/archives/C0ASWCMS0N9/), summarized below) introduces `accountId` as the unifying identifier across device/auth, messaging, payments, and Composio. SIWE / Google / Apple / X / mail auth methods all federate to one `accountId`; one `accountId` maps to N `inboxId` via an `XmtpInbox` object that proves ownership.

Why `accountId` beats the simpler "use `inboxId`" cut:

- **Inbox recovery survives.** `inboxId` changes on key rotation / lost device; `accountId` persists. Composio connections shouldn't churn on inbox changes.
- **Multi-inbox per user.** Users will have multiple inboxes (work/personal, etc.); their connections shouldn't fragment across inboxes.
- **Auth-method federation.** A Composio connection isn't tied to whichever auth method the user happened to sign in with.
- **Multi-device for free.** Same human on two devices = one Composio user. The latent multi-device bug iOS has today goes away by construction.

Concretely:
- Backend uses `accountId` (read from the JWT) as Composio's `userId` for all new OAuth flows.
- Backend's `exec` endpoint accepts `inboxId` from the agent — same identifier the agent already has from the XMTP envelope — then resolves `inboxId → accountId` via `XmtpInbox` before forwarding to Composio. Agent contract stays simple ("here's whose inbox I'm acting on behalf of"), Backend does the resolution.
- For existing connections keyed on `deviceId` in Composio, Backend falls back to `deviceId` lookup if `accountId` returns no result. Users migrate naturally on re-OAuth, no forced action.

**Sequencing:** Composio MVP-1 should land **after** (or alongside) the new auth API, not before. Otherwise we'd cut over from `deviceId` to `inboxId` in MVP-1 and then to `accountId` once auth ships — two migrations for nothing. Gate MVP-1 on `accountId` being in JWTs first.

**Open question for the auth API:** the agent → Backend.exec call hits `XmtpInbox` resolution on every invocation. Worth confirming that proof-of-ownership lookup is cheap per-call (or cacheable per-conversation).

**Alternative considered:** a `deviceId ↔ inboxId` mapping table on the Backend without going through `accountId`. Cheaper short-term but doesn't solve inbox recovery, multi-inbox, federation, or multi-device. The auth API gives us the right structural answer once.

## Orthogonal: per-agent grant scoping ([convos-ios#812](https://github.com/xmtplabs/convos-ios/pull/812))

Per-agent gating lives at the messaging layer keyed on agent `inboxId` (which agent owns the grant in this conversation). Composio's `userId` is the data owner (`accountId`). Two independent axes:

- **#812** — iOS resolver enforces "agent X's grant ≠ agent Y's grant" via `grantedToInboxId` on `CapabilityResolution`, `ConnectionEnablement`, `CloudConnectionGrant`, plus `askerInboxId` on `CapabilityRequest`.
- **This doc** — Backend's `exec` endpoint forwards to Composio with `userId: accountId`, where `accountId` is the data owner.

Both should land. They don't conflict.

## Why not the alternatives

- **Single shared project, no Backend layer (status quo with the iOS-side bug):** every agent shares one project key. No isolation between agents at the Composio layer, and the OAuth-vs-execution split is exactly the bug we have today.
- **Project per assistant (current Assistants pool config):** breaks sign-in-once. User would re-OAuth Google Calendar for every assistant they interact with. Product spec rules this out.
- **Project per user:** needs an *org-level* key on Backend to programmatically create projects — back to "one key with the keys to the kingdom." Plus likely per-project Composio billing. Push to v2.

## Open questions

@Nick

1. Does Composio's `tool_router/sessions` or scoped MCP URLs accept **action-level** scope (`GOOGLECALENDAR_EVENTS_LIST` only, not the whole toolkit)? If toolkit-only, MVP-1's proxy stays the long-term path.
2. Session TTL semantics — short-lived (minutes) preferred. Longer-lived would need revocation hooks tied to the iOS `connection_event.revoked` we already plumb.
3. Pricing — does the single-project model with high call volume cost less than project-per-user?

## Decision needed

1. Approve the Backend-mediated direction above.
2. Approve retiring the per-assistant Composio projects in Assistants pool config.
3. Assign owner for the MVP-1 Backend `exec` endpoint.

## Why this aligns with what we already shipped

- iOS PRs (`#796`, `#797`) already issue grants tagged with `(provider, capability, conversationId)` and post `connection_event` revocations. These are the inputs the Backend re-checks before any tool execution.
- iOS PR `#812` adds per-agent grant scoping (`grantedToInboxId`, `askerInboxId`). Composes naturally with this doc: per-agent gating at the messaging layer, per-account data scoping at Composio.
- `convos-assistants#1484` already relays `connection_event.revoked` into the model as a system message. When the Backend rejects an `exec` because a grant was just revoked, the model already has the context to explain why.
- No iOS changes needed regardless of the model chosen. The picker UI and the consent semantics are framework-agnostic.
