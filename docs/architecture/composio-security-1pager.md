# Composio Security Model — MVP

**Author:** Louis
**Audience:** Fabri, Nick, Mike
**Status:** Draft for sign-off

## TL;DR

Convos Backend owns all Composio connections and exposes a narrow per-call API to agents. Retire the per-assistant Composio projects in the Assistants pool config. Per-user projects can come in v2; not blocking MVP.

## The bug today

iOS authorizes Google Calendar via Convos Backend's Composio project. The connection lands there. The user's profile metadata gets a `connectionId`. The agent then tries to invoke the action via *its own* per-assistant Composio project — and finds nothing, because the connection lives in a different project.

The capability-request consent layer ([convos-ios#796](https://github.com/xmtplabs/convos-ios/pull/796) / [#797](https://github.com/xmtplabs/convos-ios/pull/797), [convos-assistants#1484](https://github.com/xmtplabs/convos-assistants/pull/1484)) is correct under any security model below. The break is purely **where the agent invokes the toolkit**.

## Recommendation: Backend mints scoped invocations

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

Today there's no link between a Convos user's grants and Composio's connections:
- iOS ↔ Backend uses `deviceId` (iOS `identifierForVendor`, encoded in the JWT).
- Backend ↔ Composio passes `deviceId` verbatim as Composio's `userId`.
- Conversation ↔ agent uses XMTP `inboxId` — the sender of `capability_request_result`.

The agent only ever has `inboxId`; the Backend only ever has `deviceId`. There's no mapping anywhere — JWT has no inboxId field, no Backend table reconciles them. Today this works only because iOS handles both sides of its own flow; the moment an agent is the caller, the link breaks.

**Recommended fix: switch Composio's `userId` to `inboxId`, with a fallback window.**

- iOS sends `inboxId` to the Backend on connection calls (header or JWT metadata).
- Backend uses `inboxId` as Composio's `userId` for all *new* OAuth flows.
- Backend's `exec` endpoint accepts `inboxId` from the agent — same identifier the agent already has from the XMTP message sender.
- For existing connections (keyed under `deviceId` in Composio), Backend falls back to `deviceId` lookup if `inboxId` returns no result. Users naturally migrate when they re-OAuth, no forced action.
- Side benefit: incidentally fixes a latent multi-device bug. Today, the same user on two devices = two Composio "users" and two separate OAuths.

**Alternative considered:** a `deviceId ↔ inboxId` mapping table on the Backend. Avoids any Composio-side migration but adds a schema model, a registration step, and 1:N ambiguity for users with multiple installs. The fallback-window approach gets us the same end state without those costs.

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
- `convos-assistants#1484` already relays `connection_event.revoked` into the model as a system message. When the Backend rejects an `exec` because a grant was just revoked, the model already has the context to explain why.
- No iOS changes needed regardless of the model chosen. The picker UI and the consent semantics are framework-agnostic.
