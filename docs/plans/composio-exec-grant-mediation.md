# Composio exec — Backend-mediated tool execution (fork Y)

> **Status**: Draft for discussion
> **Canonical security doc**: [`docs/architecture/composio-security-1pager.md`](../architecture/composio-security-1pager.md) (PR #286, revised after Nick's review)
> **Decision recorded**: fork **(Y) backend-mediates** (2026-06-09)
> **Builds on**: PR #294 — backend Composio OAuth flow keyed on `accountId`
> **Created**: 2026-06-08 · **Reframed**: 2026-06-09

## What this is

The security one-pager leaves one load-bearing decision open: **who calls Composio** —
(X) the Assistants `outbound.ts` proxy resolves the connection and calls Composio, or
(Y) the **backend** holds the key *and* the grants and makes the call itself, with the agent
calling `Backend.exec(toolkit, action, args)` and naming no connection. **We picked (Y).**
This doc is the backend implementation plan for that path. Everything here defers to the
one-pager for the threat model; it does not restate or contradict it.

## Threat model (from the one-pager — do not weaken)

Two facts make naive designs unsafe, and they hold under either fork:

1. **`user_id` is not a secret.** It's the sender's `inboxId` today (`accountId` long-term).
   A prompt-injected agent can name any value.
2. **`connected_account_id` is a bearer capability.** Composio does **not** cross-check it
   against `user_id` (confirmed by Louis). Whoever passes a `connected_account_id` can use
   that connection regardless of `user_id`.

Therefore the invariant is **not** "verify the connection belongs to the account" — an
ownership check like `getIfOwned` is *insufficient*, because possession of the id *is* the
capability. The invariant is:

> **The agent must never hold or name a `connected_account_id`, and must not be able to name
> another account.** A trusted layer resolves the connection from a trusted identity and
> injects it. The agent sends only `{ toolkit, action, args }`.

> ⚠️ This supersedes the earlier draft of this plan, which used
> `getIfOwned(connectionId, accountId)` as the gate and had the agent pass `ownerInboxId` /
> `connectionId`. Both are unsafe under fact #2 and have been removed.

## Why (Y) is clean

Under (Y) the bearer capability **never leaves the backend**. The backend already holds the
single global Composio key, already creates the connections (OAuth flow, keyed on `accountId`
per #294), and can hold the `accountId → connected_account_id` grant store. The agent contract
is the smallest possible: `Backend.exec(toolkit, action, args)`. The cost (Nick's pushback) is
a backend hop on the tool hot path — accepted as the price of keeping the bearer capability
server-side.

## The crux: where the backend gets a *trusted* identity

`Backend.exec` is called by the Assistants worker, authenticated with the shared agent key.
That key is global — it proves "an agent is calling," not "for whom." So the backend cannot
trust an account/sender field the caller simply puts in the body; that is exactly the spoof
fact #1 describes. The trusted identity must come from a signal the agent cannot forge. Two
tiers, matching the one-pager:

### Tier 1 — conversation-boundary (MVP-1)

The call is bound to the **pinned `conversationId`** (set at instance creation, never
agent-supplied). The backend resolves the connection only among the `accountId`s of *that
conversation's members*, sourced from a trusted membership lookup (Herald conversation
profiles, or the backend's own conversation record), and never from an agent-named field.

- **DM:** one member → exact per-user isolation, nothing to spoof.
- **Group:** blast radius bounded to conversation members — never a stranger in another chat.

Closes the cross-conversation leak (A asks for B, different chats) completely. The agent names
no connection. This is the shippable MVP.

### Tier 2 — per-sender (MVP-2)

Closes intra-group escalation (member B steering the agent into member A's connection). Needs
the connection resolved from the **verified sender's** `accountId`. The trusted sender signal
is Herald's HMAC-signed `senderInboxId` (one-pager Anchor 2). **Open sub-question for (Y):**
how that signal reaches the backend trustworthily — the realistic options are

- **(a)** the worker forwards Herald's HMAC-signed envelope and the **backend re-verifies the
  HMAC** itself (stateless, backend trusts the sender cryptographically, not the caller); or
- **(b)** a short-lived **per-delivery capability** the trusted runtime mints per message; or
- **(c)** Composio **scoped sessions** minted per verified sender, if they support action-level
  scope (one-pager Decision Q).

Tier 2 is explicitly out of MVP-1 scope; MVP-1 must not pretend per-sender isolation.

## Where identifiers stand (no new dependency for MVP-1)

- #294 already keys the backend's Composio **OAuth** flow on `accountId`; the grant store is
  keyed by `accountId`.
- The **agent execution** path today sends `user_id = inboxId` (the one-pager's "agent already
  uses inboxId" correction). Tier 1 resolves membership → `accountId` via Herald profiles
  (which carry both), so MVP-1 needs **no** `inboxId → accountId` table.
- The `XmtpInbox` / auth-API `accountId` federation is the long-term unifier but stays **v2**,
  gated on Borja's auth API — not blocking MVP-1.

## Consent vs. identity (two different gates)

Resolving *whose* connection (above) is identity. *Whether this agent may use it* is consent —
the iOS capability grants (`#796`/`#797`, per-agent scoping `#812`). Under (Y) the backend makes
the call, so the backend must check consent too. Whether it does so from grant records iOS
**pushes to the backend**, or by reading the messaging-layer scoping relayed via Herald, is a
secondary decision to settle during MVP-1 design — it does not change the identity model above.

## Backend surface (MVP-1, Tier 1)

- `POST /v2/composio/exec` — agent-key auth. Body: `{ conversationId, toolkit, action, args }`.
  **No connection id, no account id from the agent.**
  1. Resolve conversation membership → candidate `accountId`s (trusted lookup).
  2. Resolve the connection for `(toolkit, candidate accountIds)` from the grant store; in a DM
     this is unique. Group disambiguation beyond membership is Tier 2.
  3. Check consent (grant exists for this agent/capability/conversation).
  4. `composio.tools.execute(action, { userId: accountId, arguments: args, connectedAccountId })`
     — `connectedAccountId` injected server-side, never returned to the agent.
- Grant store: `accountId → connected_account_id` per toolkit (the backend already mints these
  in the OAuth flow; surface them to exec without ever returning the id to the agent).

`composio.tools.execute(slug, { userId, arguments, connectedAccountId? })` confirmed against
`@composio/core` `ToolExecuteParamsSchema`.

## Sequencing

1. Confirm the Tier-1 membership source (Herald profiles vs backend conversation record).
2. exec endpoint + grant-store read path, Tier 1 only, behind a flag. Tests assert: agent
   cannot name a connection; cross-conversation request → denied; DM → resolves uniquely.
3. Settle the consent source (iOS push vs Herald relay) and wire the consent check.
4. Assistants worker swaps direct Composio calls for `Backend.exec`.
5. MVP-2: Tier-2 trusted-sender mechanism (sub-question a/b/c above).

MVP-1 fail-closes: with no resolvable membership/connection, exec returns 403 before any
Composio call.

## Removed from the earlier draft (kept here so the change is auditable)

- `getIfOwned`-as-authorization — unsafe under the bearer-capability fact.
- Agent passing `ownerInboxId` / `connectionId` — the agent must name no connection.
- "Retire per-assistant Composio projects" — there is no per-assistant pool (single global key).
- Identifier alignment (deviceId→accountId) as MVP-1 work — the agent path already uses
  `inboxId`; #294 handled the backend OAuth path; `accountId` federation is v2.
