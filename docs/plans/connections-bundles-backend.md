# Connections Permission Bundles — Backend + Cross-Platform Contract

> **Status**: Plan (not yet implemented)
> **Created**: 2026-06-11 · **Owner**: Louis
> **Approved iOS plan this builds on**: convos-ios `docs/plans/connections-picker-bundles-draft.md` (PR #869, marked **approved**)
> **Builds on**: the exec/grant mediation work — convos-backend `louis/composio-exec` (`docs/plans/composio-exec-grant-mediation.md`)

## Why this exists

Review finding #3 (read-grant-can-write) can't be closed the obvious way: iOS/Android
have no Composio **action slugs** to send — they only know a toolkit and coarse verbs,
and two of the three grant entry points have no verb at all. The approved bundles plan
solves this properly: the user grants human-named **bundles** ("Events"), the device
persists only **bundle ids**, and the **backend** resolves a bundle → Composio actions at
exec time. This doc is the backend + cross-platform contract for that model. It supersedes
the interim `actions: []` plumbing and the verb-classification idea.

## Determination: one backend source, served to clients (not embedded per platform)

Decisions taken 2026-06-11:

- **Catalog storage = code config** in convos-backend (a versioned TS module). Changing
  copy/actions is a PR + redeploy; the served JSON + grant contract are identical
  regardless of storage, so a later move to DB-backed is non-breaking.
- **Contract = OpenAPI / JSON Schema in convos-backend.** Note: convos-backend has **no
  OpenAPI/schema convention today** — this establishes one (see Open Questions).

Where each piece lives:

| Piece                                                              | Lives in                                        | Shared with iOS/Android how                               | Why                                                           |
| ------------------------------------------------------------------ | ----------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------- |
| Catalog data (services → bundles → actions, copy, icons, versions) | **convos-backend** (single source, code config) | Served via `GET /v2/connections/services`                 | One source; re-map actions without an app release             |
| `bundle_id → action` resolution                                    | **convos-backend only** (exec)                  | Not shared — clients never resolve                        | Clients stay slug-free; resolution is the security boundary   |
| Config JSON shape (the contract)                                   | Backend-defined; published as a **schema**      | iOS `Codable` + Android `data class` decode the same JSON | Language-agnostic JSON + one schema = no per-platform catalog |
| Grant wire shape `{service_id, service_version, bundle_ids}`       | Backend contract                                | Both clients send on grant; backend enforces              | Specified in the approved iOS plan                            |
| Picker UI (render cards, cache, toggles)                           | **iOS** and **Android** each                    | —                                                         | Pure presentation over the fetched JSON                       |
| Staleness (`stale_resource`)                                       | Backend signals; clients refetch                | Existing CapabilityResult codec                           | iOS plan §Versioning                                          |

**Net:** nothing about the catalog is platform-specific; the only per-platform work is the
picker rendering the same JSON. No slug ever reaches a client.

## The contract (to publish as JSON Schema / OpenAPI)

**`GET /v2/connections/services`** — the picker config. Per the iOS plan:

```jsonc
{
  "services": [
    {
      "id": "googlecalendar", // == Composio toolkit slug
      "composio_slug": "googlecalendar",
      "version": 1, // bump on ANY change to this service
      "display_name": { "en": "Google Calendar" },
      "icon": { "format": "png", "base64": "..." },
      "bundles": [
        {
          "id": "calendar.events", // persisted on the grant
          "title": { "en": "Events" },
          "description": { "en": "View and edit events on all calendars" },
          "default_enabled": false,
          "composio_actions": ["GOOGLECALENDAR_LIST_EVENTS", "..."], // backend-only; see note
        },
      ],
    },
  ],
}
```

- Localized strings always carry `en` (guaranteed fallback).
- **Open:** does the served payload include `composio_actions`? The plan says the device
  "never has to know exactly which actions a bundle holds." Recommend the public config
  **omits `composio_actions`** (slugs stay backend-only); they live in the code config but
  are stripped from the GET response. Decide before publishing the schema.

**`POST /v2/connections/grants`** — grant body gains bundle fields:

```jsonc
{
  "ownerInboxId": "...",
  "granteeInboxId": "...",
  "conversationId": "...",
  "toolkit": "googlecalendar", // == service_id
  "serviceVersion": 1, // for stale detection
  "bundleIds": ["calendar.events"],
} // replaces the interim `actions`
```

## How exec authorization changes

Today (`exec.ts`): a grant carries `actions[]`; empty ⇒ whole toolkit. New model:

1. Grant stores `bundleIds[]` (and keeps `actions[]` as a legacy/fallback).
2. At exec, allowed actions = `grant.actions ∪ resolveBundleActions(toolkit, grant.bundleIds)`
   using the **current** catalog (so re-mapping needs no client update — the point of bundles).
3. If the allowed set is non-empty, the requested action must be in it (else `no_grant`).
4. **Transition default:** a grant with neither actions nor bundleIds ⇒ whole toolkit, with
   a warning log. Once clients always send bundleIds, tighten to fail-closed.

`resolveBundleActions` and the catalog are drafted in `src/api/v2/connections/bundles.config.ts`
(scaffold only — created while exploring; not wired up).

## Implementation breakdown

### Phase A — backend foundation (convos-backend, `louis/composio-exec` or a stacked branch)

1. `bundles.config.ts` — catalog + `getServiceConfig` + `resolveBundleActions` (scaffolded).
2. `GET /v2/connections/services` — serve the catalog (strip `composio_actions` if we decide
   slugs stay backend-only); versioned; cacheable (respect cache headers).
3. Schema: `ConnectionGrant.bundleIds String[] @default([])` (+ optional `serviceVersion Int?`) + migration.
4. `grants-post`: accept `bundleIds` (+ `serviceVersion`); store. Keep `actions` for transition.
5. `exec`: resolve bundle → actions and enforce (above).
6. **Contract schema**: publish the GET response + grant body as JSON Schema/OpenAPI
   (establish the convention — see Open Questions).
7. Tests: catalog resolution; exec enforces bundle scope (read bundle can't write); GET shape.

Phase A is **backward-compatible and inert** until clients send `bundleIds` (legacy grants →
whole toolkit), so it can land before the picker exists.

### Phase B — iOS picker (convos-ios, PR #869)

- Fetch + cache `GET /v2/connections/services`; render one card per bundle (title, description,
  toggle); on Done send `{toolkit, serviceVersion, bundleIds}`; handle `stale_resource` by
  refetching and retrying. Replace the interim `actions: []` push (from
  `louis/connection-grants-backend-push`) with `bundleIds`.

### Phase C — Android picker

- Same flow from the same served JSON + schema. No catalog duplication.

## Relationship to work already landed

- exec/grant backbone, the #1 (dedicated exec key + proxyConvos lockdown) and #2 (drop client
  connectionId) security fixes, and #4 (natural-key revocation) are **done**.
- The iOS `actions: []` plumbing (interim #3) is **superseded** by `bundleIds`; the backend
  `actions` column stays as a transition/legacy fallback and can be dropped once bundles ship.

## Contract schemas (the convention)

Hand-authored JSON Schema (Draft 2020-12), no new npm dependency — this is the
convos-backend contract convention going forward. Add a schema under `docs/schemas/`
for any client-facing wire shape and keep the handler zod schema as the runtime
source of truth (the JSON Schema mirrors it):

- `docs/schemas/connections-services.schema.json` — `GET /v2/connections/services`
  response (mirrors `toPublicServiceConfig`; **omits** `composio_actions`).
- `docs/schemas/connection-grant.schema.json` — `POST /v2/connections/grants` body
  (mirrors `grants-post.ts` `bodySchema`).

## Resolved decisions (2026-06-11, Phase A)

1. **Served config omits `composio_actions`.** Slugs stay backend-only; the public
   bundle carries `{id, title, description, defaultEnabled}` and the service carries
   `{id, composioSlug, version, displayName}` (icon optional, omitted in v1). Implemented
   as `toPublicServiceConfig` in `bundles.config.ts`.
2. **Contract = hand-authored JSON Schema** under `docs/schemas/` (above). No generator,
   no new dependency.
3. **Auth on `GET /v2/connections/services` = `authMiddleware` (JWT) only**, NOT
   `requireAccount` (the catalog isn't account-scoped). Mounted in `src/api/v2/index.ts`
   as a dedicated route declared before the requireAccount-gated `/connections` mount.
   Short private cache (`max-age=300`).
4. **`serviceVersion Int?` stored for audit/telemetry only.** exec always resolves bundles
   against the current catalog, never this value.
5. **Transition default kept (not fail-closed yet).** A grant with neither `actions` nor
   `bundleIds` ⇒ whole toolkit, with `req.log.warn`. Tighten once iOS+Android both send
   `bundleIds`.
6. **Seeded `googlecalendar` only.** Catalog is structured so more services are trivial to add.

## Open questions (remaining)

1. **Transition tightening**: when do we flip the empty-scope default from whole-toolkit to
   fail-closed (after iOS+Android both send bundleIds)?
2. **Catalog seeding**: which services/bundles for v1 beyond googlecalendar, and who owns the
   action lists (pulled from Composio's toolkit metadata?).
3. **Icons**: format/transport (base64 inline vs URL) once the picker needs them — the
   payload size/caching tradeoff is deferred.
