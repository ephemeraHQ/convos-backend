# Abilities (Connections V2) — Entitlements, Account Binding, and Client Integration

> **Status**: Draft PRD (for review with Mike / Borja / Andrew)
> **Created**: 2026-07-22 · **Owner**: Louis
> **Parent doc**: Notion "Abilities (Connections V2)" (goals, core components, first-round abilities)
> **Builds on**: `docs/plans/composio-exec-grant-mediation.md`, `docs/plans/connections-bundles-backend.md`, `docs/architecture/composio-security-1pager.md`
> **Companion iOS work**: convos-ios (surfaces listed in "iOS client" below)

## Why this exists

Connections V1 shipped a working Composio path, but its source of truth is smeared across
three transports and two scopes:

1. The **external credential** (Composio connected account) is account-scoped — good, keep.
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
conversation via the backend; no XMTP, no appData; V2 only — V1 is deprecated and
existing users migrate.**

This doc covers Mike's three questions plus the client:

1. How do we **enumerate** the set of possible items → the ability catalog
2. How do we **bind** entitlements to accounts → the entitlement record + auth lifecycle
3. How do entitlements **extend** from account to conversation → conversation extensions
4. How the **client** interacts with all of it → iOS integration plan (mock-first UI)

### Out of scope (owned elsewhere)

- Plugin deployment model, plugin runtime RPCs (Mike — ability orchestration)
- Agent Action Queue, debounce/rate limiting, observability, CI (Andrew)
- MCP gateway, meta tools, agent-turn initialization, harness auth handshake (Borja)
- Herald/Hermes separation (deferred, per Notion non-goals)

The entitlement **check** logic is in scope (backend function with a live consumer:
exec). Its exposure as a standalone RPC for the MCP gateway ships when Borja's gateway
contract is real — a thin wrapper, not a phase.

## Nomenclature

| Term | Meaning | Backed by |
| --- | --- | --- |
| **Ability** | One integration (Google Calendar, Spotify...) described by a manifest | Code config (versioned TS module), per bundles-doc decision |
| **Manifest** | An ability's public contract: id, name, icons, auth type, bundles; later tools[]/actions[] | Code config, served over HTTP |
| **Bundle** | The user-facing permission unit inside an ability ("Events") | Existing bundles model, unchanged |
| **Composio grant** | The external credential at the provider (Composio connected account / OAuth token) | Composio, keyed by `accountId` |
| **Entitlement** | Account ↔ ability binding with a backend-owned lifecycle status | New `AbilityEntitlement` row |
| **Conversation ability** | An entitlement extended into one conversation | New `ConversationAbility` row (reshaped `ConnectionGrant`) |

## Target model

```
Ability manifest (code config, versioned)
        │  enumerated by
        ▼
GET /v2/abilities  ──────────────  catalog × caller's entitlement state
        │
Account ──< AbilityEntitlement >── ability_id, status, credential ref, expiry
        │         │ 1:N
        │         ▼
        │   ConversationAbility ── conversation_id, bundle_ids
        │
        └── checkEntitlement(account, conversation, ability, tool?)
                 │ consumed by exec today, MCP gateway later
                 ▼
        allowed actions | typed denial
```

Three invariants:

- **The backend is the only source of truth.** No grant data travels over XMTP or appData.
  Agents learn what they may do by asking the backend (exec today; gateway meta tools
  later), never by reading conversation metadata.
- **Credentials live at account scope; conversations hold references.** Connecting a
  service happens once per account; extending it to a conversation is a cheap row.
- **Extensions are conversation-level, not per-agent.** V1 keyed grants by
  `granteeInboxId` and iOS fanned out one grant per agent inbox. V2 drops this: the
  gateway/exec caller is authenticated by its own channel (worker secret today, bearer
  handshake later), and the entitlement answers for `(account, conversation, ability)`.

## Contracts

Conventions: everything below `authMiddleware`; mutation endpoints also `requireAccount`.
New namespace `/v2/abilities` — `/v2/connections/*` keeps serving V1 clients during the
migration window and is then removed. JSON Schema published under `docs/schemas/` with an
`assertLegacyShapeValidates` test, per house convention. Wire casing: camelCase
(matches the majority of v2; the services contract's snake_case does not carry over).

### Enumerate — `GET /v2/abilities`

One response: full catalog × caller entitlement state. Device-only JWTs (no SIWE account
yet) get the catalog with `entitlement: null` — browsable, not entitleable.

```jsonc
{
  "catalogVersion": 3,            // bump on any manifest change
  "abilities": [
    {
      "id": "googlecalendar",
      "version": 2,               // per-ability version (staleness handling)
      "displayName": { "en": "Google Calendar" },
      "subtitle": { "en": "Read and edit events" },
      "icon": { "iosUrl": "https://...", "androidUrl": "https://..." },
      "auth": { "type": "oauth" },     // "oauth" | "none"; callback specifics stay backend-side
      "bundles": [
        {
          "id": "calendar.events",
          "title": { "en": "Events" },
          "description": { "en": "View and edit events on all calendars" },
          "defaultEnabled": true
        }
      ],
      "entitlement": {                 // null when not entitled / no account
        "status": "active",            // pending_auth | active | needs_reauth | expired | revoked
        "expiresAt": "2026-09-01T00:00:00Z",
        "conversationIds": ["..."]     // where it's extended
      }
    }
  ]
}
```

- Composio action slugs never appear (security boundary, unchanged from bundles doc).
- `tools[]` / `actions[]` (MCP + queue schemas) are part of the manifest **internally**
  from day one so plugin registration emits the same shape later, but are not served to
  clients until the gateway needs them.
- Client refresh: on launch, on foreground, on abilities-screen appearance. Payload is
  small; `catalogVersion` + `If-None-Match` can come later if it ever matters.

### Bind — entitlement lifecycle

- `POST /v2/abilities/{abilityId}/entitlement` → create/restart. OAuth abilities return
  `{ "status": "pending_auth", "redirectUrl": "..." }` (Composio initiate under the
  hood); auth-less abilities return `active` immediately. Idempotent per
  `(account, ability)`.
- `POST /v2/abilities/{abilityId}/entitlement/complete` → post-callback ownership
  verification (mirrors V1 `complete`), flips to `active`.
- `DELETE /v2/abilities/{abilityId}/entitlement` → revoke: cascades conversation
  extensions, deletes the Composio connected account, keeps a tombstoned row for audit.

Lifecycle is **service-mediated**: a periodic backend job revalidates credentials against
Composio and flips `active → needs_reauth | expired`. Clients only ever read status; they
never derive it. Account deletion tears down entitlements + external credentials via the
deletion barrier (coordinate with `docs/plans/delete-my-account.md`; the external-purge
step already lists Composio).

### Extend — conversation abilities

- `GET /v2/conversations/{conversationId}/abilities` → the conversation's view (what's
  extended, by whom — for the conversation info screen).
- `PUT /v2/conversations/{conversationId}/abilities/{abilityId}` body
  `{ "bundleIds": ["calendar.events"] }` → extend/update. Requires an `active`
  entitlement; 409 `needs_entitlement` otherwise.
- `DELETE /v2/conversations/{conversationId}/abilities/{abilityId}` → withdraw.

`conversationId` remains an opaque XMTP string (no Conversation table), as with V1 grants.

### Check — the enforcement function

Internal service function, not an endpoint at first:

```
checkEntitlement(accountId, conversationId, abilityId, tool?)
  → { allowed: true, actions: [...] }
  | { allowed: false, code: "no_entitlement" | "not_extended_to_conversation"
                          | "needs_reauth" | "unknown_ability" | "invalid_tool" }
```

- **Day-one consumer**: `POST /v2/composio/exec` migrates onto it (same wire contract,
  reads the new tables).
- **Later consumer**: MCP gateway (`/v2/internal/entitlements/check` + an enumerate
  variant for the meta tools), exposed once the gateway contract is agreed with Borja.
- The **denial vocabulary is the cross-team contract to freeze early**: these codes drive
  the agent's escalation prompts ("ask the user to grant X") and the iOS error UX,
  regardless of which caller hits the check.

## Data model (conceptual)

- **`AbilityEntitlement`**: `id`, `accountId` (FK, cascade), `abilityId`, `status`,
  `externalConnectionId?` (backend-only, never served), `abilityVersion`, `expiresAt?`,
  `revokedAt?`, timestamps. Unique `(accountId, abilityId)`.
- **`ConversationAbility`**: `id`, `entitlementId` (FK, cascade), `conversationId`,
  `bundleIds[]`, timestamps. Unique `(entitlementId, conversationId)`. Index
  `(conversationId, abilityId-via-join)` for the check path.
- `status` as String + CHECK constraint (house pattern; no Postgres enums).
- **Backfill** (boot-time guarded routine + advisory lock, `migrate-user-ids.ts`
  pattern): distinct `(ownerAccountId, toolkit)` from live `ConnectionGrant` rows → one
  `AbilityEntitlement`; each live grant → one `ConversationAbility`, collapsing the
  per-`granteeInboxId` fan-out (union of `bundleIds` on collision).

## iOS client

Two tracks; Track A needs zero backend.

### Track A — mock-first UI (start immediately, iterate with design)

Protocol-first per house conventions: `AbilitiesServiceProtocol` + `MockAbilitiesService`
returning static catalog/entitlement fixtures; all screens previewable before any
endpoint exists.

1. **Filterable ability list** (account level) — revamp `Convos/App Settings/ConnectionsListView.swift`:
   searchable, server-driven icons/copy, entitled/available sections, status badges,
   connect/disconnect + re-auth actions.
2. **Authorize flow** — OAuth via the existing `OAuthSessionProvider` machinery;
   `pending_auth` and `needs_reauth` states.
3. **Per-conversation toggles** — revamp `Convos/Conversation Detail/ConversationConnectionsSection.swift`:
   one toggle per ability (no agent fan-out), bundle selection, "needs entitlement" state
   that deep-links to the ability list.
4. **Escalation prompt** — evolve `Convos/Capabilities/CapabilityApprovalSheetView.swift`
   for agent-initiated permission requests (driven later by the action queue).
5. **Expiry/re-auth nudge** — top-of-home banner via the existing
   `safeAreaInset(.top)` chrome (`ConversationsView` / `MainTabView.sharedTopBar`),
   shown when any entitlement is `needs_reauth`/`expired`.

### Track B — transport + V1 excision (lands with the backend endpoints)

1. `/v2/abilities` endpoints in `ConvosAPIClient` (+ `MockAPIClient`), models per
   `CloudConnectionsAPI.swift` conventions; refresh on launch/foreground/screen-appear.
2. **Delete the non-HTTP grant legs** in `CloudConnectionGrantWriter.swift`: the XMTP
   `ProfileUpdate` write and the appData `ConversationProfile.connections` write. HTTP
   becomes the only transport.
3. Delete the hardcoded `CloudConnectionServiceCatalog`; render the served catalog.
4. Local DB: repoint `DBCloudConnectionGrant` at the new shape (or replace with
   entitlement + extension tables mirroring the backend).

**Hard dependency for B2**: the agent runtime must stop reading
`ProfileUpdate.metadata["connections"]` before (or at the same time as) the client stops
writing it — otherwise agents go blind while V1 conversations still exist. Sequencing to
agree with Mike: runtime reads backend first, then the client excision ships.

## Rollout

1. Backend: manifests + `GET /v2/abilities`; register the six launch abilities
   (Google Calendar first, then Coinbase read-only, Shopify, Spotify, YouTube, Gmail).
2. Backend: entitlement + extension tables, lifecycle endpoints, backfill, exec on
   `checkEntitlement`. V1 `/v2/connections/*` handlers become adapters over the new
   tables (old clients keep working, one source of truth).
3. iOS: Track A screens land behind the existing feature-gating; Track B wires them up.
4. Client excision (B2 above) once the runtime reads backend-only.
5. Remove V1 endpoints + adapters when shipped-client traffic drains.

## Open questions

1. **Icon delivery**: manifest URLs (S3/CDN, per Notion) vs V1's inline base64. URLs
   recommended; needs an upload/versioning story.
2. **Old-client window**: how long do `/v2/connections/*` adapters live? ("V2 only" was
   agreed, but shipped clients exist; needs a forced-upgrade or drain decision.)
3. **Bundles in the manifest**: confirmed as the user-facing permission unit? (Notion
   manifest lists `tools[]`/`actions[]` only; this doc keeps bundles — exec and both
   UIs already speak them.)
4. **Per-agent scoping**: sign off that nothing needs `granteeInboxId` granularity after
   the gateway authenticates callers itself.
5. **Escalation transport**: how the "request user permission" meta tool reaches the
   client (push? in-conversation message? poll) — Borja/Andrew dependency; UI is mocked
   meanwhile.
6. **`conversationIds` in `GET /v2/abilities`**: convenient for the nudge + ability list,
   but grows with usage; cap or move behind the per-conversation endpoint?

## Success criteria

- A single developer adds ability #7 by writing one manifest + Composio config and
  redeploying the backend — no client release, it appears in both apps' catalogs.
- Zero grant/connection data written to XMTP or appData; the backend answers every
  "who may do what where" question.
- Denied agent calls return typed codes that surface as escalation prompts, not silent
  failures.
- Entitlement status transitions (expiry, revocation, re-auth) originate server-side and
  reach the UI by polling alone; the home nudge fires without any client-side derivation.
- Account deletion leaves no orphaned entitlements or Composio connected accounts.
