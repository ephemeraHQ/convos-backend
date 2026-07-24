# Abilities (Connections V2) - Entitlements, Account Binding, and Client Integration

> **Status**: Draft PRD - review rounds 1 (2026-07-22) and 2 (2026-07-23) incorporated
> **Created**: 2026-07-22 | **Owner**: Louis
> **Parent doc**: Notion "Abilities (Connections V2)" (goals, core components, first-round abilities)
> **Builds on**: `docs/plans/composio-exec-grant-mediation.md`, `docs/plans/connections-bundles-backend.md`, `docs/architecture/composio-security-1pager.md`
> **Companion iOS work**: convos-ios (surfaces listed in "iOS client" below)

## Why this exists

Connections V1 shipped a working Composio path, but its source of truth is smeared across
three transports and two scopes:

1. The **external credential** (Composio connected account) is account-scoped - good, keep.
2. The **per-conversation grant** is written three times by the iOS client: an XMTP
   `ProfileUpdate` message (`metadata["connections"]`, the agents' current read path), a
   best-effort appData copy (`ConversationProfile.connections`, field 5), and the backend
   `ConnectionGrant` row (enforced at exec time).
3. The **catalog** is split: backend `bundles.config.ts` knows one service; iOS carries its
   own hardcoded display catalog on top.

This makes the client the mediator of the connection lifecycle, makes agent visibility
depend on conversation metadata, and makes adding ability #2 a two-platform release.

V2 decisions (meetings 2026-07-20, aligned): **account-level grant model managed by the
backend; our nomenclature is "entitlements"; entitlements extend from account to
conversation via the backend; no XMTP, no appData; V2 only - V1 is deprecated and
existing users migrate.**

This doc answers three questions plus the client integration:

1. How do we **enumerate** the set of possible items -> the ability catalog
2. How do we **bind** entitlements to accounts -> the entitlement record + auth lifecycle
3. How do entitlements **extend** from account to conversation -> conversation extensions
4. How the **client** interacts with all of it -> iOS integration plan (mock-first UI)

### Out of scope (owned elsewhere)

- Plugin deployment model, plugin runtime RPCs (ability orchestration workstream)
- Agent Action Queue, debounce/rate limiting, observability, CI
- MCP gateway, meta tools, agent-turn initialization, harness auth handshake
- Herald/Hermes separation (deferred, per Notion non-goals)

The entitlement **check** logic is in scope (backend function with a live consumer:
exec). Its exposure as a standalone RPC for the MCP gateway ships when the gateway
contract is real - a thin wrapper, not a phase.

## Nomenclature

| Term | Meaning | Backed by |
| --- | --- | --- |
| **Ability** | One integration (Google Calendar, Spotify...) described by a manifest | Code config (versioned TS module), per bundles-doc decision |
| **Manifest** | An ability's public contract: id, name, icons, auth type, bundles; later tools[]/actions[] | Code config, served over HTTP |
| **Bundle** | The user-facing permission unit inside an ability ("Events") | Existing bundles model, unchanged |
| **Composio grant** | The external credential at the provider (Composio connected account / OAuth token) | Composio, keyed by `accountId` |
| **Entitlement** | Account <-> ability binding with a backend-owned lifecycle status | New `AbilityEntitlement` row |
| **Conversation ability** | An entitlement extended to an agent within one conversation | New `ConversationAbility` row (reshaped `ConnectionGrant`) |

Review discussion deliberately used generic language to keep naming honest: a
"binding" is the account <-> service credential + privileges (our entitlement), and the
per-conversation "opt-in" allows an agent in a conversation to use privileges scoped to
a particular binding (our conversation ability).

## Target model

```
Ability manifest (code config, versioned)
        │  enumerated by
        ▼
GET /v2/abilities  ──────────────  catalog x caller's entitlement state
        │
Account ──< AbilityEntitlement >── ability_id, status, credential ref, expiry
        │         │ 1:N
        │         ▼
        │   ConversationAbility ── conversation_id, agent_inbox_id, bundle_ids
        │
        └── checkEntitlement(conversation, agent, ability, tool?, onBehalfOf?)
                 │ resolves the owner account; consumed by exec today, MCP gateway later
                 ▼
        allowed actions | typed denial
```

Four invariants:

- **The backend is the only source of truth.** No grant data travels over XMTP or appData.
  Agents learn what they may do by asking the backend (exec today; gateway meta tools
  later), never by reading conversation metadata.
- **Credentials live at account scope; conversations hold references.** Connecting a
  service happens once per account; extending it to a conversation is a cheap row.
- **Extensions are scoped to an agent within a conversation.** The opt-in names the
  agent by its immutable inbox/instance ID, not just the conversation: agents can join,
  leave, or sit in many conversations, and there is no bearer proof that agent X is a
  member of conversation Y - tying access to an immutable identity keeps soundness
  provable. A second agent joining a conversation does not silently inherit the first
  agent's access; it triggers a fresh opt-in.
- **Validation happens at the MCP edge, never in plugins.** The gateway proves
  (initiating user, agent, conversation participation) via whatever PKI fits the proof
  (conversation keys, inbox keys), yielding a trusted (caller account ID, agent ID,
  conversation ID) triple. The backend answers access levels for that trusted triple;
  plugins receive already-validated identities and the resolved credentials only.

## Contracts

Conventions: everything below `authMiddleware`; mutation endpoints also `requireAccount`.
New namespace `/v2/abilities` - `/v2/connections/*` keeps serving V1 clients during the
migration window and is then removed. Response contracts are documented as JSON Schema
under `docs/schemas/`; request schemas get `assertLegacyShapeValidates` pins when the
mutation endpoints (bind, extend) land, per house convention. Wire casing: camelCase
(matches the majority of v2; the services contract's snake_case does not carry over).

### Enumerate - `GET /v2/abilities`

One response: full catalog x caller entitlement state. Device-only JWTs (no SIWE account
yet) get the catalog with `entitlement: null` - browsable, not entitleable.

```jsonc
{
  "catalogVersion": 3,            // bump on any served-catalog change (manifests and bundles)
  // "entitlementsUnavailable": true  -- present only when entitlement state could not
  //                                     be derived (upstream outage); abilities then
  //                                     carry no entitlement key at all - see below
  "abilities": [
    {
      "id": "googlecalendar",
      "version": 2,               // per-ability version (staleness handling)
      "displayName": { "en": "Google Calendar" },
      "subtitle": { "en": "Read and edit events" },
      "icon": { "iosUrl": "https://...", "androidUrl": "https://..." },  // optional until the asset story lands (open question 1)
      "auth": { "type": "oauth" },     // "oauth" | "none"; callback specifics stay backend-side
      "bundles": [
        {
          "id": "calendar.events",
          "title": { "en": "Events" },
          "description": { "en": "View and edit events on all calendars" },
          "defaultEnabled": true
        }
      ],
      "entitlement": {                 // object or null when authoritative; omitted under entitlementsUnavailable
        "status": "active",            // pending_auth | active | needs_reauth | expired | revoked
        "expiresAt": "2026-09-01T00:00:00Z",
        "extensionCount": 2            // distinct conversations this entitlement is extended to
      }
    }
  ]
}
```

- On an authoritative response (no `entitlementsUnavailable` flag), `entitlement` has
  exactly two states: an object (entitled, server-owned status) or `null` (not
  entitled, or device-only caller).
- When entitlement state cannot be derived (upstream outage, missing or incomplete
  upstream state), the catalog still serves with top-level
  `entitlementsUnavailable: true` and the abilities carry no `entitlement` key at
  all: clients keep last-known state instead of rendering "not connected". Clients
  branch on the flag, never on key presence, which generated decoders cannot
  reliably distinguish from `null`.
- Status provenance: the V1-derived adapter emits `pending_auth`, `active`, and
  `expired` only, mapped from Composio connected-account state at read time:
  in-progress auth reads as `pending_auth`, an active credential as `active`, and
  every terminal or unknown state collapses to `expired` (unknown states are
  logged). `needs_reauth` is reserved for the service-mediated revalidation job to
  set, and `revoked` for explicit user revocation - both arrive with the
  entitlement tables.
- `extensionCount` is the number of distinct conversations the entitlement is
  extended to - the user-meaningful unit - in the V1-adapter era (distinct
  conversations across live grants) and once the tables land (distinct
  `conversationId` values over `ConversationAbility` rows) alike. It is a bounded
  summary for the ability list and the re-auth nudge; per-conversation, per-agent
  detail comes only from `GET /v2/conversations/{conversationId}/abilities`.
- Composio action slugs never appear (security boundary, unchanged from bundles doc).
- `tools[]` / `actions[]` (MCP + queue schemas) join the manifest **internally** when
  the gateway work lands, so plugin registration emits the same shape; they are not
  part of the day-one manifest and are never served to clients until the gateway
  needs them.
- Client refresh: on launch, on foreground, on abilities-screen appearance. Payload is
  small; `catalogVersion` + `If-None-Match` can come later if it ever matters.

### Bind - entitlement lifecycle

- `POST /v2/abilities/{abilityId}/entitlement` -> create/restart. OAuth abilities return
  `{ "status": "pending_auth", "redirectUrl": "..." }` (Composio initiate under the
  hood); auth-less abilities return `active` immediately. Idempotent per
  `(account, ability)`.
- `POST /v2/abilities/{abilityId}/entitlement/complete` -> post-callback ownership
  verification (mirrors V1 `complete`), flips to `active`.
- `DELETE /v2/abilities/{abilityId}/entitlement` -> revoke: cascades conversation
  extensions, deletes the backing Composio connected account (and any duplicate
  connections for the same toolkit - see the multi-credential rule in the data model),
  keeps a tombstoned row for audit.

Lifecycle is **service-mediated**: a periodic backend job revalidates credentials against
Composio and flips `active -> needs_reauth | expired`. Clients only ever read status; they
never derive it. Account deletion tears down entitlements + external credentials via the
deletion barrier (coordinate with `docs/plans/delete-my-account.md`; the external-purge
step already lists Composio).

### Extend - conversation abilities

- `GET /v2/conversations/{conversationId}/abilities` -> the conversation's view: one
  entry per `(ability, agent)` opt-in, with who extended it - for the conversation info
  screen.
- `PUT /v2/conversations/{conversationId}/abilities/{abilityId}` body
  `{ "agentInboxId": "...", "bundleIds": ["calendar.events"] }` -> extend/update the
  opt-in for that agent. Requires an `active` entitlement; 409 `needs_entitlement`
  otherwise.
- `DELETE /v2/conversations/{conversationId}/abilities/{abilityId}?agentInboxId=...` ->
  withdraw that agent's opt-in.

`conversationId` remains an opaque XMTP string (no Conversation table), as with V1 grants.

### Check - the enforcement function

Internal service function, not an endpoint at first:

```
checkEntitlement(conversationId, agentInboxId, abilityId, tool?, onBehalfOf?)
  -> { allowed: true, ownerAccountId, actions: [...] }
   | { allowed: false, code: "no_grant" | "ambiguous_grant" | "invalid_action"
                           | "needs_reauth" | "unknown_ability" }
```

The trusted identity on the exec path is the `(conversation, agent)` pair the worker
stamps as `x-convos-conversation-id` / `x-convos-agent-inbox-id` headers; no caller can
prove an initiating account ID on that path today. The check therefore resolves the
candidate owner accounts from the trusted pair, uses the optional `onBehalfOf` selector
(which exec already accepts) to pick between multiple members who extended the same
ability, and denies with `ambiguous_grant` when it cannot pick. An account ID becomes
an input only once a caller can prove one (the MCP gateway's PKI validation); until
then the check must not require it.

- **Day-one consumer**: `POST /v2/composio/exec` migrates onto it (same wire contract,
  reads the new tables). Before that migration, freeze an explicit mapping from every
  HTTP status and error code exec emits today to its `checkEntitlement` equivalent;
  the migration must not change observable exec behavior.
- **Later consumer**: MCP gateway (`/v2/internal/entitlements/check` + an enumerate
  variant for the meta tools), exposed once the gateway contract is agreed.
- The **denial vocabulary is the cross-team contract to freeze early**: these codes drive
  the agent's escalation prompts ("ask the user to grant X") and the iOS error UX,
  regardless of which caller hits the check. It keeps exec's existing codes verbatim
  (`no_grant`, `ambiguous_grant`, `invalid_action` - no renames) and only adds
  lifecycle codes additively.

## Data model (conceptual)

- **`AbilityEntitlement`**: `id`, `accountId` (FK, cascade), `abilityId`, `status`,
  `externalConnectionId?` (backend-only, never served), `abilityVersion`, `expiresAt?`,
  `revokedAt?`, timestamps. Unique `(accountId, abilityId)`.
- **`ConversationAbility`**: `id`, `entitlementId` (FK, cascade), `conversationId`,
  `agentInboxId`, `bundleIds[]`, timestamps. Unique
  `(entitlementId, conversationId, agentInboxId)`. Index
  `(conversationId, agentInboxId)` for the check path.
- `status` as String + CHECK constraint (house pattern; no Postgres enums).
- **Backfill** (boot-time guarded routine + advisory lock, `migrate-user-ids.ts`
  pattern): entitlements source from the union of the Composio connected-account
  inventory (paginated and resumable; one candidate per `(accountId, toolkit)`) and
  the distinct `(ownerAccountId, toolkit)` pairs from live `ConnectionGrant` rows -
  connected-but-never-granted accounts must not be dropped. Each live grant then maps
  1:1 to a `ConversationAbility` (`granteeInboxId` carries over as `agentInboxId`).
- **Multi-credential rule**: one `AbilityEntitlement` per `(account, ability)`. When
  several Composio connections exist for the same toolkit, the most-usable one (best
  lifecycle status) backs the entitlement; the remaining connections are deleted when
  the entitlement is revoked.
- **Rolling deploy**: the V1-endpoints-as-adapters switch ships in the same deploy as
  the backfill. While that deploy rolls out, old replicas can still write legacy
  `ConnectionGrant` state; the backfill is idempotent and is re-run
  (RuntimeConfig-ledgered) after full rollout as a reconciliation sweep, so late
  legacy writes converge into the new tables.

## iOS client

Two tracks; Track A needs zero backend.

All V2 surfaces ship dark behind a feature flag, toggleable from the debug menu on dev
builds; the V1 connections UI stays the default until Track B is wired to live
endpoints. House feature flags are UserDefaults-backed and hard-locked off in
production builds - there is no remote-config system - so public enablement is a
default flip shipped in a client release, not a server-side switch. The flag still
lets Track A land continuously without exposing half-built surfaces and gives
design/QA a switch for side-by-side comparison against V1 on dev builds.

### Track A - mock-first UI (start immediately, iterate with design)

Protocol-first per house conventions: `AbilitiesServiceProtocol` + `MockAbilitiesService`
returning static catalog/entitlement fixtures; all screens previewable before any
endpoint exists.

1. **Filterable ability list** (account level) - revamp `Convos/App Settings/ConnectionsListView.swift`:
   searchable, server-driven icons/copy, entitled/available sections, status badges,
   connect/disconnect + re-auth actions. The revamp covers the cloud/ability rows
   only; the device-capability rows sharing this list today stay feature-gated off
   and are out of scope here.
2. **Authorize flow** - OAuth via the existing `OAuthSessionProvider` machinery;
   `pending_auth` and `needs_reauth` states.
3. **Per-conversation toggles** - revamp `Convos/Conversation Detail/ConversationConnectionsSection.swift`:
   one toggle per ability per agent (single-agent conversations render as one plain
   toggle), bundle selection, "needs entitlement" state that deep-links to the ability
   list. A newly added agent never inherits - it surfaces a fresh opt-in prompt.
4. **Escalation prompt** - evolve `Convos/Capabilities/CapabilityApprovalSheetView.swift`
   for agent-initiated permission requests (driven later by the action queue).
5. **Expiry/re-auth nudge** - top-of-home banner via the existing
   `safeAreaInset(.top)` chrome (`ConversationsView` / `MainTabView.sharedTopBar`),
   shown when any entitlement is `needs_reauth`/`expired`.

### Track B - transport + V1 excision (lands with the backend endpoints)

1. `/v2/abilities` endpoints in `ConvosAPIClient` (+ `MockAPIClient`), models per
   `CloudConnectionsAPI.swift` conventions; refresh on launch/foreground/screen-appear.
   On a response with `entitlementsUnavailable: true`, keep last-known entitlement
   state; never downgrade the UI to "not connected".
2. **Delete the non-HTTP grant legs** in `CloudConnectionGrantWriter.swift`: the XMTP
   `ProfileUpdate` write and the appData `ConversationProfile.connections` write. HTTP
   becomes the only transport.
3. Delete the hardcoded `CloudConnectionServiceCatalog`; render the served catalog.
   The hardcoded catalog offers Google Drive, which the backend never served - its
   fate is open question 5.
4. Local DB: repoint `DBCloudConnectionGrant` at the new shape (or replace with
   entitlement + extension tables mirroring the backend).

**Hard dependency for Track B item 2**: the agent runtime must stop reading
`ProfileUpdate.metadata["connections"]` before (or at the same time as) the client stops
writing it - otherwise agents go blind while V1 conversations still exist. The runtime
currently has no way to discover which abilities it may use: exec only enforces a known
requested action, and no worker-authenticated enumerate API exists yet. The cutover
therefore has an explicit prerequisite chain: the backend workstream ships a
worker-authenticated per-conversation/per-agent enumerate endpoint; the agent-runtime
workstream moves to a dual read (backend first, XMTP metadata as fallback); backfill
coverage is verified; only then does the client excision ship. The XMTP fallback and
the V1 adapters are removed last.

## Rollout

1. Backend: manifests + `GET /v2/abilities`; register the six launch abilities
   (Google Calendar first, then Coinbase read-only, Shopify, Spotify, YouTube, Gmail).
   Manifests can be registered hidden (present in config, not served); clearing the
   hidden flag is the per-ability launch switch.
2. Backend: entitlement + extension tables, lifecycle endpoints, backfill, exec on
   `checkEntitlement`. V1 `/v2/connections/*` handlers become adapters over the new
   tables in the same deploy as the backfill (old clients keep working, one source
   of truth; rolling-deploy note in the data model).
3. iOS: Track A screens land dark behind the abilities feature flag (debug-menu toggle
   on dev builds); Track B wires them up.
4. Backend: worker-authenticated per-conversation/per-agent enumerate endpoint;
   agent-runtime workstream moves to the dual read (backend first, XMTP fallback).
5. Client excision (Track B item 2) once backfill coverage is verified and the runtime
   reads backend-first.
6. Remove V1 endpoints + adapters and the runtime's XMTP fallback when shipped-client
   traffic drains.

## Determinations

From the 2026-07-22 review:

- **Extensions keep agent scoping.** The opt-in binds `(conversation, agent inbox ID)`,
  not the conversation alone. Rationale: inbox/instance IDs are immutable; there is no
  bearer proof of an agent's conversation membership; agents can be removed from or sit
  in multiple conversations. Soundness stays provable.
- **No silent inheritance.** A second agent added to a conversation does not inherit
  the first agent's access; each agent gets its own opt-in.
- **Validation layering.** The MCP edge validates (initiating user, agent, conversation
  participation) via whatever PKI fits the proofs, yielding a trusted (caller account
  ID, agent ID, conversation ID) triple. Each agent turn carries the original caller's
  account and conversation. Plugins never validate; they receive validated identities
  and resolved credentials only. The backend check answers access levels for the
  trusted triple.

From the 2026-07-23 review:

- **The catalog summary is bounded.** `GET /v2/abilities` reports `extensionCount`
  (distinct conversations, the user-meaningful unit) per entitlement instead of a
  conversation-ID list: an ID list grows with lifetime usage and erases the agent
  dimension (the authoritative key is entitlement x conversation x agent).
  Per-conversation, per-agent detail comes only from
  `GET /v2/conversations/{conversationId}/abilities`.
- **One explicit availability flag, no presence-sniffing.** On authoritative
  responses per-ability `entitlement` is an object or `null`; under the top-level
  `entitlementsUnavailable` flag the key is omitted entirely. Clients branch on the
  flag, never on key presence, which generated decoders cannot reliably distinguish
  from `null`.
- **The check trusts the (conversation, agent) pair, not an account ID.** No day-one
  caller can prove an initiating account, so `checkEntitlement` resolves owner
  candidates from the trusted pair plus the optional `onBehalfOf` selector and keeps
  exec's denial vocabulary verbatim.

## Implementation determinations (B2 build)

Decisions made while building the entitlements core, recorded here because they
refine (not change) the contracts above:

- **The extension row carries `actions`, `extendedByInboxId`, and `expiresAt`** beyond
  the spec's column floor. Live V1 grants set per-grant action scopes, an extender
  inbox ID (`onBehalfOf` matching, "extended by" display), and per-grant expiry that
  exec enforces; without these fields a 1:1 grant map would either widen scoped grants
  to whole-toolkit or break them. All three drain with the V1 adapters.
- **Exec authorization stays extension-row-based during migration.** The conversation
  check is byte-faithful to V1 exec and deliberately does not consult entitlement
  lifecycle status; lifecycle gating arrives with the revalidation phase. Until then
  an `active` entitlement never self-expires - only user action or a sweep touches it.
- **Extension PUT requires non-empty `bundleIds`.** An empty V2 scope would alias the
  legacy whole-toolkit transition default in the check - a fail-open trap. Withdrawal
  is DELETE, not an empty PUT.
- **Entitlement DELETE is teardown-first.** External credentials are revoked at
  Composio before any local write: a Composio outage answers 502 and an unconfigured
  service answers 503, both with the row untouched, so revocation is retryable and no
  external credential is ever stranded behind a local tombstone.
- **Cutover is triple-gated and re-runnable.** Reads flip to the new tables only when
  three ledgers agree: user-id migration done, backfill at the current epoch, and a
  post-drain cutover marker written after a delayed drain sweep converges anything old
  replicas wrote. The reconciliation sweep is epoch-keyed (bump the constant to re-run
  once per environment), and the Composio inventory scan holds an owner-token lease
  (TTL with renewal, CAS release) so a fleet restart scans from at most one replica.
- **Catalog guard for unusable abilities.** A visible OAuth ability that resolves to
  zero public bundles is excluded from the served catalog (and its version hash) and
  logged; bind and extend then 404 it, while entitlement DELETE still works.

## Open questions

1. **Icon delivery**: manifest URLs (S3/CDN, per Notion) vs V1's inline base64. URLs
   recommended; needs an upload/versioning story.
2. **Old-client window**: how long do `/v2/connections/*` adapters live? ("V2 only" was
   agreed, but shipped clients exist; needs a forced-upgrade or drain decision.)
3. **Bundles in the manifest**: confirmed as the user-facing permission unit? (Notion
   manifest lists `tools[]`/`actions[]` only; this doc keeps bundles - exec and both
   UIs already speak them.)
4. **Escalation transport**: how the "request user permission" meta tool and the
   new-agent opt-in prompt reach the client (push? in-conversation message? poll) -
   gateway/action-queue dependency; UI is mocked meanwhile.
5. **Google Drive**: the hardcoded iOS catalog offered Google Drive, but the backend
   never served it. Register it as a hidden manifest (existing credentials keep
   meaning; the ability can launch later) or drop it and delete any stray grants
   during backfill?

## Success criteria

- A single developer adds ability #7 by writing one manifest + Composio config and
  redeploying the backend - no client release, it appears in both apps' catalogs.
- Zero grant/connection data written to XMTP or appData; the backend answers every
  "who may do what where" question.
- Denied agent calls return typed codes that surface as escalation prompts, not silent
  failures.
- Entitlement status transitions (expiry, revocation, re-auth) originate server-side and
  reach the UI by polling alone; the home nudge fires without any client-side derivation.
- Account deletion leaves no orphaned entitlements or Composio connected accounts.
