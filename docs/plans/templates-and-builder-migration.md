# Templates and Builder Migration

> **Status:** Locked **Owner:** @saul **Created:** 2026-05-06 **Source spec:** internal design doc "Move assistant generation and templates from pool to convos-backend"
>
> **Post-merge update (2026-05-08):** Re-stacked on `fbac/authentication-api` (Borja's auth PR #194). Account model now uses UUID primary keys (`@db.Uuid` with `gen_random_uuid()`) instead of `acct_`-prefixed strings. The `acct_admin` seed row uses a deterministic UUID `48a05ef4-4a71-57a0-957f-a3d410992b31` (exported as `ADMIN_ACCOUNT_ID` from `@/utils/prefixed-id`). All `ownerAccountId` references updated accordingly.

## Locked Deviations from the Spec

The following deviations from the original spec were agreed upon with the user before implementation. They are locked — do not re-litigate without explicit user sign-off.

1. **`camelCase`** JSON field names — The spec prescribes `snake_case` JSON fields (e.g. `agent_name`, `first_published_at`), but every existing handler in convos-backend already uses `camelCase` (e.g. `ownerAccountId`, `firstPublishedAt`, `hasMore`, `nextCursor`). Using `camelCase` avoids introducing a casing helper and cutover risk; new handlers match the existing repo convention.

2. **`kebab-case`** URL paths — The spec prescribes `snake_case` URL paths (`/api/v2/agent_templates`), but the existing routes in convos-backend use `kebab-case` (e.g. `/v2/invite-codes`, `/v2/auth-check`). The implementation uses `/api/v2/agent-templates` to match the established URL path convention.

3. **`XMTP_ENV !== "production"`** production guard — The spec prescribes an allowlist guard (`XMTP_ENV ∈ {dev, staging}`), but the existing `/api/v2/dev` route uses `XMTP_ENV !== "production"` (deny-list semantics). The implementation matches this precedent so tests "just work" with `XMTP_ENV=local` (the test-runner default) and unset environments are treated as non-production, matching the existing repo convention.

4. **`builder.template.generated`** PostHog event name — The spec leaves the PostHog event name unspecified. The implementation locks it to `builder.template.generated` using a dotted namespace convention that is consistent with PostHog's recommended event naming patterns and avoids collision with future events.

## Context

Three product capabilities are blocked by the same missing piece — there's no account abstraction on convos-backend, and no link between templates and the instances deployed from them.

- **Agent contacts** — deployable agent instances from versioned template ids, addressable from a user's contact list.
- **Payments** — a recoverable, billable user account on the backend to attach balances and credit history to.
- **Agent builder** — first-class templates users can edit, fork, and republish as their own.

The full migration consolidates identity, templates, instance ownership, and credits onto convos-backend. This plan covers **only the templates + builder slice**. Auth, credits, instance lifecycle, and runtime skill materialization are owned by other workstreams and land separately.

### Today

- Pool owns `agent_skills` (single editable card per skill: `agentName`, `prompt`, `description`, `category`, `emoji`, `tools`, `published`, `featured`, `publishedByInbox`). All template-shaped data lives there.
- Pool owns AI generation: `POST /api/skills/generate` (dashboard-authed) and `POST /api/proxy/skills/generate` (instance-authed) — long-running SSE, OpenRouter-backed, ~50–90s tail.
- Runtime callers (`runtime/convos-platform/skills/assistant-builder/scripts/handlers/{publish,unpublish,build}.mjs`) talk to pool via `gatewayToken`.
- Dashboard (`dashboard/`) reads `/api/skills` for its home and create pages.
- convos-backend has no user/account model. JWTs are device-bound (Firebase AppCheck → ES256 JWT, 15-min). A previous `User` model was removed in `20250814133750_remove_user_model`.

### Target (full picture, for reference only)

The eventual end-state on backend is `Account`, `XmtpInbox`, `AuthMethod`, `Profile`, `AgentTemplate`, `AgentSkill`, `AgentSkillFile`, `AgentTemplateSkill`, `AgentInstance`, `CreditBalance`, `CreditLedger`, `GrantKind`. **This plan ships a strict subset.**

## Scope of this plan

**In:**

- `Account` model, with one seeded synthetic admin row.
- `AgentTemplate` (owner, fork lineage, version, status, prompt, tools, connections, avatar).
- `AgentSkill` + `AgentSkillFile` + `AgentTemplateSkill` with **versioned files** (snapshot bundling).
- Builder module on backend: SSE generation route, ported from `pool/src/services/skillGen.ts` and `pool/data/skill-generator-prompt.txt`.
- Spend metering for the builder via PostHog event (no DB write).

**Out (other owners / later phases):**

- SIWE / wallet auth, `AuthMethod`, `XmtpInbox`, `Profile` — auth workstream.
- `AgentInstance`, pool column additions, claim-flow rewiring — new claiming backend (replacing pool entirely).
- `CreditBalance`, `CreditLedger`, `GrantKind`, `/agents/credits/{check,consume}` — credits workstream.
- Runtime skill materialization (downloading `AgentSkillFile` rows to `$STATE_DIR/skills/...`) — runtime workstream.
- Cutover of pool's existing `agent_skills` — clean slate, no migration of existing rows.

**Authorization until SIWE lands:** every template and skill in this PR has `ownerAccountId = acct_admin`. Writes accept either the existing JWT (any authed device) or `X-Agent-API-Key`; reads are public. No per-row author tracking, no admin-deviceId allowlist. This slice does not ship to production until real accounts land — dev/staging is fine because anything authored pre-auth is admin-owned by definition.

## Schema (Prisma)

ID convention: app-generated prefixed strings (`<prefix>_<random>`). No `@default(uuid())` on the `id` columns; ids are minted at insert time. Matches the design doc.

**The block below is the final-state schema after PR 5.** Earlier PRs land tables and relation fields progressively — see PR sequencing for the per-PR diff. Specifically: `Account.agentTemplates` joins land in PR 2; `Account.agentSkills` and `AgentSkill.*` in PR 4; `AgentTemplate.skills`, `AgentSkill.templates`, and `AgentTemplateSkill` itself in PR 5.

```prisma
enum PublishStatus { draft published unlisted archived }
// draft     = private to owner. GET 404s to anyone but the owner. (Pre-SIWE: 404s to all GETs; writers see drafts only via the write response.)
// unlisted  = link-shareable. GET by id/hashed_slug resolves to anyone; not in list endpoints. Bundleable. Used for fork-internal skills.
// published = link-shareable AND listed in the public gallery.
// archived  = pulled by owner. GET by id/hashed_slug still resolves (existing links keep working); not in list endpoints. New bundles rejected; existing bundles continue to resolve.

model Account {
  id        String   @id                       // acct_<random>
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  agentTemplates AgentTemplate[]
  agentSkills    AgentSkill[]
}

model AgentTemplate {
  id                   String   @id                  // tmpl_<random>
  slug                 String                         // per-owner; URL form is `<slug>.<hash5>` where hash5 is derived from id (pool's `lib/slug-hash.ts` pattern)
  ownerAccountId       String
  forkedFromId         String?
  agentName            String
  description          String?
  prompt               String   @db.Text
  category             String?
  emoji                String?
  avatarUrl            String?                        // S3 URL via existing /api/v2/agents/assets/presigned (X-Agent-API-Key path)
  tools                String[] @default([])
  connections          String[] @default([])          // permission-based connections the agent is capable of; prefix convention "composio:<slug>" | "apple_health" | …
  version              Int      @default(1)
  firstPublishedAt     DateTime?                       // null = never published; gates slug immutability and the first-publish status flip
  status               PublishStatus @default(draft)
  featured             Boolean  @default(false)
  createdAt            DateTime @default(now())
  updatedAt            DateTime @updatedAt

  owner       Account              @relation(fields: [ownerAccountId], references: [id])
  forkedFrom  AgentTemplate?       @relation("Forks", fields: [forkedFromId], references: [id])
  forks       AgentTemplate[]     @relation("Forks")
  skills      AgentTemplateSkill[]

  @@unique([ownerAccountId, slug])
  @@index([slug])                                       // public hashed-slug lookup queries slug=base across all rows
  @@index([status, createdAt, id])                      // keyset pagination on status=published lists
  @@index([status, category, createdAt, id])            // keyset pagination on status+category filter
  @@index([status, featured, createdAt, id])            // keyset pagination on status+featured filter (admin-curated gallery rail)
  @@index([forkedFromId])
}

model AgentSkill {
  id                    String   @id                  // skl_<random>
  slug                  String                         // per-owner; URL form is `<slug>.<hash5>`
  ownerAccountId        String
  forkedFromId          String?
  name                  String
  description           String?
  version               Int      @default(1)          // current latest version; in-flight draft when version > lastPublishedVersion
  lastPublishedVersion  Int?                           // null = never published; otherwise highest published version (immutable bundle)
  status                PublishStatus @default(draft)   // gallery state only — independent of file-version state
  createdAt             DateTime @default(now())
  updatedAt             DateTime @updatedAt

  owner       Account              @relation(fields: [ownerAccountId], references: [id])
  forkedFrom  AgentSkill?          @relation("SkillForks", fields: [forkedFromId], references: [id])
  forks       AgentSkill[]         @relation("SkillForks")
  files       AgentSkillFile[]
  templates   AgentTemplateSkill[]

  @@unique([ownerAccountId, slug])
  @@index([slug])                                       // public hashed-slug lookup queries slug=base across all rows
  @@index([status, createdAt, id])                      // keyset pagination on status=published lists
  @@index([forkedFromId])
}

// Per-version row, frozen once that skillVersion publishes.
// At deploy, runtime joins AgentTemplateSkill → AgentSkillFile via (skillId, skillVersion).
model AgentSkillFile {
  id           String   @id                    // sklf_<random>
  skillId      String
  skillVersion Int                              // version this row belongs to
  path         String                           // "SKILL.md", "references/<sub-skill>.md", "references/<script>.{py,js,sh}", …
  content      String   @db.Text                // small content inline; large blobs can move to S3 later, keyed by (skillId, skillVersion, path)
  mimeType     String?
  createdAt    DateTime @default(now())

  skill        AgentSkill @relation(fields: [skillId], references: [id], onDelete: Cascade)

  @@unique([skillId, skillVersion, path])
  @@index([skillId, skillVersion])
}

model AgentTemplateSkill {
  templateId   String
  skillId      String
  skillVersion Int                              // pinned at bundle time; must reference a published skill version
  createdAt    DateTime @default(now())          // bundling order, in case skill materialization order matters later

  template     AgentTemplate @relation(fields: [templateId], references: [id], onDelete: Cascade)
  skill        AgentSkill    @relation(fields: [skillId], references: [id], onDelete: Restrict)

  @@id([templateId, skillId])
  @@index([skillId])
}
// Cascade on template (join rows belong to the template).
// Restrict on skill: route layer rejects skill delete when bundled, but Restrict is defense-in-depth — without it, cascade would silently nuke join rows mid-deploy.
```

### Versioning rules (load-bearing)

- **Two orthogonal states.** A skill has a _file-version state_ (driven by `version` and `lastPublishedVersion`) and a _gallery state_ (driven by `status`). They are independent.
- **File-version state** (derived):
  - `lastPublishedVersion IS NULL` → never published; current row content is at `version = 1` and mutable.
  - `version == lastPublishedVersion` → no draft in progress; current published version's row set is frozen.
  - `version > lastPublishedVersion` → in-flight draft at `version`; published version's rows still readable.
- **Gallery state** (`status` enum, independent of file state):
  - `draft` → private to owner. Default for new skills. Pre-SIWE this means GET 404s for everyone; the writer sees their draft only in the write response.
  - `unlisted` → link-shareable, not in gallery lists. Bundleable. Used by deep-fork's internal skill copies.
  - `published` → link-shareable AND listed in the public gallery. May have an in-flight file draft (`version > lastPublishedVersion`) — the gallery still shows `lastPublishedVersion` content while the next version drafts.
  - `archived` → pulled from gallery; direct links still resolve so existing references keep working. New bundles rejected; existing bundles continue to resolve and deploy.
- **Per-version mutability.** `AgentSkillFile` rows tagged with a draft version are mutable. Once a version publishes, all rows tagged with that `skillVersion` are frozen forever.
- **At most one draft.** Either no draft exists (`version == lastPublishedVersion`) or one draft exists at `version = lastPublishedVersion + 1` (or `version = 1` before any publish).
- **Publish** sets `lastPublishedVersion = version` and freezes that row set. On the **first** publish (when `lastPublishedVersion` was previously `NULL` and `status = draft`), it also flips `status` to `published` by default, or to `unlisted` if the publish call supplies `?status=unlisted` (publishes the files but keeps the row out of the gallery — link-shareable only). Subsequent publishes leave `status` alone, so a skill that's been `unlisted` or `archived` stays in that state when the owner publishes a new version's files.
- **Editing a published skill** increments `version` to `lastPublishedVersion + 1`; `status` is _not_ touched. The new draft starts empty; writes populate it. The gallery continues to show the current `lastPublishedVersion` content.
- **Bulk vs per-path writes (load-bearing for runtime parity).** Two write shapes, both subject to the same path/size validation (see file-write limits below):
  - **Bulk replace** — `PUT /agent_skills/{id}/files` with body `{ files: [{ path, content, mimeType? }, ...] }`. Atomically replaces the entire row set for the current draft version with the supplied bundle. The runtime's `assistant-builder` skill builds locally on disk and posts the full set this way; no clone needed because the caller supplies it.
  - **Per-path** — `PUT /agent_skills/{id}/files/{path*}` and `DELETE /agent_skills/{id}/files/{path*}`. On the _first_ per-path mutation against a fresh draft (when `version > lastPublishedVersion` and no rows exist yet for `version`), the handler **transactionally clones every `AgentSkillFile` row from `lastPublishedVersion` into the new draft version, then applies the mutation.** Subsequent per-path writes operate within the existing draft set. Without this clone, granular edits would publish a partial bundle missing every file the user didn't touch.
  - **Concurrency.** Wrap clone+mutate in a single transaction. Take a row-level lock on the parent `AgentSkill` row (`SELECT ... FOR UPDATE`) before the clone, or use `INSERT ... ON CONFLICT DO NOTHING` for the clone batch and tolerate the conflict as "already cloned." Either prevents two simultaneous first-edits from racing on `@@unique([skillId, skillVersion, path])`.
  - The two shapes can interleave: bulk-replace overwrites the draft set whatever its current shape; per-path operates on whatever's there. First-mutation cloning triggers only when the draft has zero rows.
- **Bundling.** `AgentTemplateSkill` requires `skillVersion <= lastPublishedVersion` AND `skill.status != archived`. Drafts cannot be bundled. New bundles against archived skills are rejected; existing bundles continue to resolve and deploy normally.
- **Re-bundling / repinning.** PK is `(templateId, skillId)`, so a template bundles each skill at most once. `POST /agent_templates/{id}/skills` with a `skill` already bundled updates the row's `skillVersion` to the skill's current `lastPublishedVersion` (idempotent repin). Callers who want a specific older version pass `skill_version` explicitly in the body.
- **`PATCH /agent_skills/{id}` handles metadata and post-publish status transitions.** Allowed body fields: `name`, `description`, `slug` (immutable post-publish; see URL slug discriminator), `status`. Metadata mutates the live row immediately (not versioned — only file content is). Status transition rules via PATCH:
  - `published ↔ unlisted` — free.
  - `published | unlisted → archived` — free.
  - `archived → published | unlisted` — un-archive, free.
  - `* → draft` — rejected once `lastPublishedVersion IS NOT NULL` (can't return to private after publishing). A never-published skill is already `draft` by default; no transition needed.
  - `draft → *` — not reachable via PATCH. Drafts only enter the gallery via the publish endpoint (which auto-flips to `published`, or to `unlisted` if `?status=unlisted` is supplied).
- **Forking a skill** creates a new `AgentSkill` owned by the caller (`forkedFromId` set, `version = 1`, `lastPublishedVersion = NULL`) and copies the source's `lastPublishedVersion` `AgentSkillFile` rows into the new skill at `version = 1`. The fork starts as a draft; caller publishes when ready.
- **Publish requirements.** Publish handler validates that `AgentSkillFile` exists for `(skillId = $id, skillVersion = $version, path = 'SKILL.md')`. Without `SKILL.md` runtime materialization fails; rejecting at publish keeps the contract enforceable upstream.
- **Delete behavior on `forkedFromId`.** Prisma's default `SetNull` on optional FKs applies — deleting a parent template or skill clears `forkedFromId` on all forks. Lineage is lost when the parent is deleted; forks survive as standalone rows. Accepted: deletion is rare, and forks losing their back-pointer is preferable to blocking deletes.
- **Cascade on owned children.** `AgentSkillFile` cascades on `AgentSkill` delete (files belong to one skill). `AgentTemplateSkill` cascades on `AgentTemplate` delete (join rows belong to the template). The skill rows themselves are _not_ affected — deleting a template never deletes a bundled skill, since skills are independent rows that may be bundled by other templates.

### Template-version semantics (instance-side)

`AgentTemplate` is one mutable row. The `version` counter is a **deploy marker**, not a content snapshot:

- `PATCH /agent_templates/{id}` handles content fields (`prompt`, `tools`, `connections`, `avatarUrl`, `agentName`, `description`, `category`, `emoji`), `slug` (immutable post-publish; same rule as skills), and post-publish `status` transitions. Allowed status transitions match skill PATCH: `published ↔ unlisted`; `published | unlisted → archived`; `archived → published | unlisted`; `* → draft` rejected after first publish. **`draft → *` is NOT reachable via PATCH** — the first transition out of `draft` happens via the publish endpoint (matches skill semantics). Content mutations land in the live row immediately — **publish is NOT a content-visibility gate after first publish**: edits to a published template are immediately visible in the gallery, and the next deploy will pick them up. Owner calls `/publish` only when they want a new deploy marker (e.g., to mark "this is the curated next-version snapshot"). No template-level content history.
- `POST /agent_templates/{id}/publish` is the first-publish gateway. On the **first** publish (when `firstPublishedAt IS NULL`) it sets `firstPublishedAt = NOW()`, leaves `version` at 1 (so the first deploy marker is `1`, not `2`), and flips `status` to `published` by default — or `unlisted` if `?status=unlisted` supplied. Subsequent publishes increment `version` (refresh the deploy marker for new claims) and leave `status` alone — re-publishing an unlisted/archived template doesn't put it back in the gallery.
- Adding or removing a bundled skill (`AgentTemplateSkill`) mutates the live row immediately, same as `PATCH`. No version bump on its own; user calls `/publish` when they want the deploy marker to advance.
- All deploy-time immutability lives on `AgentInstance` rows: each instance snapshots `(prompt, tools, connections, avatarUrl, [(skillId, skillVersion), ...])` at deploy time. Republishing a template never touches live instances.

Trade-off accepted: the gallery cannot answer "what did template T look like at version 3?" — that history exists only on whatever instances were deployed during that window. If gallery-side history becomes a requirement later, add an `AgentTemplateVersion` snapshot table; nothing in this schema blocks that.

### Seeds

- One row in `Account` with id `acct_admin`. Embed the seed in the PR-1 migration SQL itself (`INSERT INTO "Account" ("id", "createdAt", "updatedAt") VALUES ('acct_admin', NOW(), NOW()) ON CONFLICT ("id") DO NOTHING;`). This way `prisma migrate deploy` is the only deploy step needed; no external seed script in the deploy path.
- No `GrantKind` seeds (out of scope here).

### URL slug discriminator

`slug` is per-owner unique in the DB (`@@unique([ownerAccountId, slug])`). URLs use `<slug>.<hash5>` where `hash5` is derived from the row's `id` via pool's existing `slugHash` algorithm: take the first 32 bits of `sha1(id)` (8 hex chars), parse as a base-16 integer, render as base-36, and pad/truncate to exactly 5 chars. Pool's `pool/src/lib/slug-hash.ts` (`buildSlug` / `slugHash` / `isHashedSlug`) is lifted verbatim into backend so the algorithm stays identical.

**Slug validation:** `slug` must match `^[a-z0-9][a-z0-9-]*$` (lowercase alphanumeric + hyphens, must start with alphanumeric, no dots), max 64 chars. This guarantees the URL form `<slug>.<hash5>` parses unambiguously.

**Slug mutability:** `slug` may be changed via `PATCH` while the row has never been published (`AgentSkill.lastPublishedVersion IS NULL` for skills; `AgentTemplate.firstPublishedAt IS NULL` for templates). Once the row has published once, `slug` is **immutable** — old links continue working. (`hash5` is derived from `id`, which never changes, so links survive ownership transfer too. Slug changes after publish would break in-the-wild links since the `slug = base` lookup keys off the current value.)

The hash is **one-way** (sha1-truncated); resolvers cannot derive `id` from `hash5`. Public URLs don't carry owner identity, so the resolver always queries by `slug = base` across **all** rows (no owner narrowing — the per-owner unique constraint means at most one match per owner, but multiple owners can share a base slug). For each candidate row, compute `slugHash(row.id)` and compare to the URL's `hash5`. Exactly one match → resolved. Zero or multiple matches → 404. (The 5-char hash gives ~60M values; collisions across same-`base` rows are vanishingly rare but the resolver handles them by 404'ing rather than guessing.)

### Reserved slugs

Action words that cannot be used as a slug at any time, since they would shadow action endpoints under the same path prefix: `generate`, `publish`, `fork`, `search`, `files`, `templates`, `skills`. Reserved-slug validation runs on **both** creation (`POST /agent_templates`, `POST /agent_skills`) and slug-changing `PATCH` calls — pre-publish slug PATCHes must not slip a reserved word in.

## API surface

Conventions follow the source design doc: snake_case paths and JSON fields, ISO 8601 `*_at` timestamps with `Z`, `object` discriminator on every resource, references drop `_id` suffix and become inlined objects under `?expand[]=…`, `updated_at` not serialized into responses. `DELETE` returns HTTP 200 with `{ "object": "<type>", "id": "<id>", "deleted": true }` so clients can confirm the type and update local caches without inferring success from a bare 204.

**List envelope and cursor shape.** All list endpoints return `{ data, has_more, next_cursor }`. Cursor is opaque to the client: server emits a base64url-encoded JSON `{ "id": "<last_row_id>", "createdAt": "<iso>" }` reflecting the row's primary sort. Default `limit=20`, max `100`; offset is not supported. Deterministic ordering: lists sort by `(createdAt DESC, id DESC)` unless a route documents otherwise; the cursor's `(createdAt, id)` pair is used in a keyset comparison (`WHERE (createdAt, id) < ($cursor.createdAt, $cursor.id)`).

All routes mount under `/api/v2`.

### Templates

| Method   | Path                                      | Auth                     | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------- | ----------------------------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`    | `/agent_templates`                        | public                   | returns `status = published` rows only; `?status=` filter is **rejected** pre-SIWE (no concept of "list my drafts/unlisted/archived" without per-account ownership); filters: `category`, `owner`, `featured` (boolean, defaults to false-meaning-all). `featured` is admin-only to _set_ — no public route mutates it; admins flip it via direct DB / a future admin route — but the `?featured=true` filter is publicly readable so the gallery can surface a curated rail |
| `GET`    | `/agent_templates/{id_or_hashed_slug}`    | public                   | resolves for `published`, `unlisted`, `archived`; 404 for `draft`. Expands: `skills`, `skills.files`, `owner`. **`skills.files` returns files at each join row's pinned `skillVersion`**, NOT the bundled skill's current `lastPublishedVersion` — so a template viewed in the gallery shows the exact bundle that would deploy                                                                                                                                              |
| `POST`   | `/agent_templates`                        | jwt or `X-Agent-API-Key` | owner = `acct_admin`. Server pins `status = draft`, `version = 1`, `firstPublishedAt = NULL` regardless of body — first publish must go through `/publish`                                                                                                                                                                                                                                                                                                                   |
| `PATCH`  | `/agent_templates/{id}`                   | jwt or `X-Agent-API-Key` | content fields, `slug` (mutable only pre-first-publish), and post-publish `status` transitions. `draft → *` rejected; first publish must go through `/publish`. See Template-version semantics                                                                                                                                                                                                                                                                               |
| `DELETE` | `/agent_templates/{id}`                   | jwt or `X-Agent-API-Key` | **rejects if `firstPublishedAt IS NOT NULL`** — published rows must be archived (via PATCH `status=archived`) instead of hard-deleted, so existing URLs continue resolving. Drafts can be hard-deleted. Forks survive; their `forkedFromId` is cleared (Prisma default `SetNull`)                                                                                                                                                                                            |
| `POST`   | `/agent_templates/generate`               | jwt or `X-Agent-API-Key` | **builder** — SSE; replaces pool's `/api/skills/generate`                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `POST`   | `/agent_templates/{id}/publish`           | jwt or `X-Agent-API-Key` | first publish: sets `firstPublishedAt = NOW()`, leaves `version = 1`, flips `status` `draft → published` (or `→ unlisted` if `?status=unlisted` supplied). Subsequent publishes: increments `version`, leaves `status` alone                                                                                                                                                                                                                                                 |
| `POST`   | `/agent_templates/{id}/fork`              | jwt or `X-Agent-API-Key` | shallow fork in PR 3, **upgraded to deep fork in PR 5** — see Template fork semantics below. Allowed on any source `status` _except_ `draft`. Body may include `{ "slug"?: "<override>" }`; if omitted, server auto-generates a slug per the fork-slug strategy. Caller can rename via PATCH while the new template is pre-publish                                                                                                                                           |
| `POST`   | `/agent_templates/{id}/skills`            | jwt or `X-Agent-API-Key` | bundle a skill: body `{ "skill": "skl_…", "skill_version"?: <int> }`. Default pins skill's current `lastPublishedVersion`; explicit `skill_version` pins an older one. Rejects if `skill.lastPublishedVersion IS NULL` (never published), `skill.status = archived`, `skill_version > skill.lastPublishedVersion`, or `skill_version < 1`                                                                                                                                    |
| `DELETE` | `/agent_templates/{id}/skills/{skill_id}` | jwt or `X-Agent-API-Key` | unbundle                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

`POST /agent_templates/generate` is the builder route. SSE pattern matches pool's current shape: 15s keep-alive comments, single `event: result` or `event: error` terminating the stream. Returns a synthesized template draft; client persists via `POST /agent_templates`.

### Skills

| Method   | Path                                              | Auth                     | Notes                                                                                                                                                                                                                                                                                                                                 |
| -------- | ------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`    | `/agent_skills`                                   | public                   | returns `status = published` rows only; `?status=` filter is **rejected** pre-SIWE; filters: `owner`                                                                                                                                                                                                                                  |
| `GET`    | `/agent_skills/{id_or_hashed_slug}`               | public                   | resolves for `published`, `unlisted`, `archived`; 404 for `draft`. Expands: `files`, `owner`; returns content at `lastPublishedVersion`                                                                                                                                                                                               |
| `GET`    | `/agent_skills/{id_or_hashed_slug}/files/{path*}` | public                   | always returns the row at `lastPublishedVersion` (drafts not readable via GET; writers see their drafts via the write response). 404 if `lastPublishedVersion IS NULL`                                                                                                                                                                |
| `GET`    | `/agent_skills/{id}/templates`                    | public                   | parent skill must satisfy direct-read rules (404 if skill is `draft`); returned templates filtered to `status = published` only (so non-published templates don't leak via reverse lookup). Paginated; uses `@@index([skillId])` on the join                                                                                          |
| `POST`   | `/agent_skills`                                   | jwt or `X-Agent-API-Key` | metadata only. Server pins `status = draft`, `version = 1`, `lastPublishedVersion = NULL` regardless of body — first publish must go through `/publish`                                                                                                                                                                               |
| `PATCH`  | `/agent_skills/{id}`                              | jwt or `X-Agent-API-Key` | partial; metadata fields (`name`, `description`, `slug`) and `status` transitions. See versioning rules for allowed transitions                                                                                                                                                                                                       |
| `PUT`    | `/agent_skills/{id}/files`                        | jwt or `X-Agent-API-Key` | **bulk replace** — body `{ files: [...] }`, atomically swaps current draft's row set; runtime path uses this                                                                                                                                                                                                                          |
| `PUT`    | `/agent_skills/{id}/files/{path*}`                | jwt or `X-Agent-API-Key` | per-path write to current draft version; first per-path mutation against an empty draft transactionally clones `lastPublishedVersion` rows first (see versioning rules)                                                                                                                                                               |
| `DELETE` | `/agent_skills/{id}/files/{path*}`                | jwt or `X-Agent-API-Key` | per-path remove from current draft version; same first-mutation clone rule                                                                                                                                                                                                                                                            |
| `POST`   | `/agent_skills/{id}/publish`                      | jwt or `X-Agent-API-Key` | freezes current draft, sets `lastPublishedVersion = version`. On first publish also flips `status` `draft → published` (or `→ unlisted` if `?status=unlisted` supplied); subsequent publishes leave `status` alone (an `unlisted` or `archived` skill stays in that state). Rejects if no `SKILL.md` exists at the publishing version |
| `POST`   | `/agent_skills/{id}/fork`                         | jwt or `X-Agent-API-Key` | copies `lastPublishedVersion` files into a new draft skill owned by caller. Allowed on any source `status` _except_ `draft`. Body may include `{ "slug"?: "<override>" }`; if omitted, server auto-generates per the fork-slug strategy. New skill is `draft`, so caller can rename via PATCH before publishing                       |
| `DELETE` | `/agent_skills/{id}`                              | jwt or `X-Agent-API-Key` | **rejects if `lastPublishedVersion IS NOT NULL`** (published rows must be archived instead) OR if any `AgentTemplateSkill` references any version of this skill (would orphan a deployable bundle). Drafts that have never published can be hard-deleted. Forks survive with `forkedFromId` cleared (Prisma default `SetNull`)        |

**File write limits and path validation** apply to **both** `PUT /agent_skills/{id}/files` (bulk) and `PUT /agent_skills/{id}/files/{path*}` (per-path). Bulk write rejects the entire request if any single file violates a constraint:

- Path: no leading `/`, no `..` segments, max 256 chars, max depth 8, top-level must be `SKILL.md` or `references/...`.
- Extension allowlist: `.md`, `.py`, `.js`, `.mjs`, `.sh`, `.html`, `.txt`, `.json`. Anything else → 400.
- Per-file size: 256 KB.
- Per-skill aggregate: max 64 files, max 4 MB across all `AgentSkillFile` rows for the current draft version.

Path-shape constraints (no leading `/`, no `..`, max length, max depth) also apply to per-path `DELETE /agent_skills/{id}/files/{path*}` for path lookup; size/aggregate constraints don't apply to DELETE since it removes content. These limits are intentionally tight; they protect PR 4 writes before runtime materialization lands. The runtime workstream can relax them when it owns the on-disk contract.

### Template fork semantics

Fork behavior changes between PR 3 (shallow) and PR 5 (deep). Both ship the same endpoint; PR 5 upgrades the body of the fork handler.

**PR 3 — shallow fork.** No skills exist yet, so the fork is just step 1 below:

1. Creates a new `AgentTemplate` owned by the caller (`forkedFromId` points at source). Copies the source's live `prompt`, `tools`, `connections`, `avatarUrl`, `agentName`, `description`, `category`, `emoji`. New template starts at `version = 1`, `status = draft`, `firstPublishedAt = NULL` — fork is treated as a fresh, never-published template. Caller must call `/publish` to enter their gallery.

**PR 5 — deep fork.** The endpoint above gains steps 2 and 3, run in the same transaction:

2. For each `AgentTemplateSkill` row on the source, creates a **new forked `AgentSkill`** owned by the caller (`forkedFromId` points at the source skill). Copies the source skill's files **at the join row's pinned `skillVersion`** (not the source skill's current `lastPublishedVersion`) into the new skill at `version = 1`. Sets `lastPublishedVersion = 1` AND `status = unlisted` — the forked skill is bundleable but does NOT enter the public skill gallery. **The forked skill's slug is generated by the fork-slug strategy below; once the deep-forked skill lands, its slug is immutable** (because `lastPublishedVersion` is immediately set), so the caller cannot rename it later. They can promote it to `published` via PATCH if they want it gallery-listed.
3. Inserts new `AgentTemplateSkill` rows on the forked template, pinned to each newly-forked skill at its v1.

**Migration semantics.** Templates forked during the PR-3-through-PR-4 window stay shallow forever — they have no `AgentTemplateSkill` rows, mirroring the source's empty bundle at fork time. PR 5's upgrade only affects _new_ forks; old forks aren't retroactively deepened.

### Fork slug strategy

Both fork endpoints (standalone skill fork, deep-forked template + internal skills) need a slug for each new row. Strategy:

1. **Caller-supplied slug** (via `{ "slug": "<override>" }` in the fork body, where the API supports it): validated against the slug regex, reserved-slug list, and the per-owner uniqueness constraint. Rejected on conflict (caller picks a different slug and retries).
2. **Auto-generated** when no slug is supplied: server picks `<source.slug>` if available per the calling owner, else `<source.slug>-2`, `-3`, … incrementing until a free slot is found. Implementation: a single transaction with `INSERT ... ON CONFLICT (ownerAccountId, slug) DO NOTHING` retried with the next suffix, capped at e.g. 1000 attempts before erroring (defense against pathological collision storms).
3. For **deep-forked internal skills** (which auto-publish as `unlisted` and thus have immutable slugs from the moment they land), the same auto-generation rule applies. Callers who care about internal-skill slug aesthetics can supply per-skill overrides via the deep-fork body (`{ "skill_slugs": { "<source_skill_id>": "<new_slug>", ... }}`) — otherwise auto-generation handles it. The deep-forked skill slugs are typically not user-facing because the bundled skills resolve through the template's URL, not as standalone gallery entries.

The forking caller ends up with a fully owned copy of the template _and_ every bundled skill. Editing the forked template's skills doesn't affect the original. Trade-off: forking is heavier than a shallow reference-fork; favored here because it matches the "give me my own copy of everything" mental model of an agent builder. Honoring the source's pinned `skillVersion` (not its current `lastPublishedVersion`) means the fork captures the bundle as-deployed, not as the source skill stands today — symmetric with how instances snapshot at deploy.

### Skill metadata PATCH

`PATCH /agent_skills/{id}` mutates `name`, `description`, and `slug` on the live row immediately, regardless of draft state. Metadata is not versioned — only file content is.

### Auth notes (transitional)

Pre-auth, every row has `ownerAccountId = acct_admin`. Writes accept either:

- **JWT path (dashboard / app).** Existing `authMiddleware`. Any authed device passes — no admin allowlist.
- **Runtime path.** Existing `agentApiKeyAuth` middleware. The chain spans three names for one secret: server env `AGENT_ASSETS_API_KEY` (validated by `src/middleware/agentAuth.ts`), HTTP header `X-Agent-API-Key` (sent by callers), runtime env `CONVOS_API_KEY` (what convos-cli reads). Same value, three labels. Reusing this key couples assets and templates auth — anyone with the key controls both. Acceptable for now; sets us up to either scope the existing key or split into `AGENT_TEMPLATES_API_KEY` later without schema impact.

Read access pre-SIWE:

- **Direct lookup** (`GET /{type}/{id_or_hashed_slug}`): resolves for `published`, `unlisted`, `archived`. 404 for `draft`. Anyone with the URL can view unlisted/archived rows.
- **List endpoints** (`GET /{type}`): return `status = published` only. The `?status=` filter is rejected pre-SIWE — there's no per-account concept of "list my drafts" yet.
- **File reads** (`GET /agent_skills/{id_or_hashed_slug}/files/{path*}`): always return `lastPublishedVersion` content; 404 if `lastPublishedVersion IS NULL` or `status = draft`. Drafts are not GET-readable in this slice — writers see their drafts only via the write response.

When SIWE lands, owners can list their own drafts/unlisted/archived rows by passing auth. This slice skips that to avoid temporary `optionalAuth` middleware.

Trust model: "anyone authed at all can mutate the gallery." Acceptable because the slice doesn't ship to production until real accounts and SIWE auth land.

**Production guard.** Routers must NOT mount in production. Fail-closed by deny-list per locked deviation #3, reading `process.env.XMTP_ENV` **raw** (NOT the imported `XMTP_ENV` constant from `src/config.ts`, which defaults unset to `"dev"`). Mount only when `process.env.XMTP_ENV !== "production"`, matching the existing `/api/v2/dev` precedent so `XMTP_ENV=local` (the test-runner default) and unset environments are treated as non-production. The `AGENT_TEMPLATES_ENABLED` env var is _not_ introduced; a misset enable flag would unlock the surface in prod. Tests cover positive (`"dev"`, `"staging"`, `"local"`, unset, mixed-case `"Production"`) and the negative (`"production"`) value, all read from `process.env` directly.

## Builder module

Lifts `pool/src/services/skillGen.ts` + `pool/data/skill-generator-prompt.txt` into `convos-backend/src/api/v2/agent_templates/`:

- `agent-templates.router.ts` — new top-level `agentTemplatesRouter`, mounted at `/api/v2/agent_templates` (NOT under `agentsRouter`, which carries `agentJoinLimiter` and the wrong path prefix).
- `handlers/generate-template.ts` — port of `handleGenerateSkill` minus pool-specific concerns.
- `services/templateGen.ts` — port of `generateSkill` (OpenRouter call, multimodal handling, brevity rail).
- `data/template-generator-prompt.txt` — verbatim copy of the system prompt.

Differences from the pool version:

- Spend metering writes a PostHog event per generation (`{ model, prompt_tokens, completion_tokens, latency_ms, request_id, auth_mode }` where `auth_mode` is `"jwt"` or `"agent_key"`; `request_id` is a fresh uuid per request). USD cost is _not_ logged here — it derives downstream from model + token counts. Without per-row author tracking, this telemetry is the only abuse/debug trail. No `CreditLedger` write — that workstream lands later, at which point this becomes a debit call.
- Auth: existing JWT (any authed device) or `X-Agent-API-Key` (runtime). Pool's `/api/proxy/skills/generate` stays live until the runtime workstream cuts over (see Risks).
- **Response casing and field set.** Pool's `skillGen.ts` returns `{ agentName, description, prompt, category, emoji, tools }` (camelCase, no `connections`). The new builder result normalizes to snake_case AND adds `connections: []` server-side at the API boundary — pool's prompt doesn't emit it today, so the backend defaults the field to an empty array unless/until the prompt is updated to emit it. Final shape: `{ agent_name, description, prompt, category, emoji, tools, connections }`. Dashboard and runtime clients will need a one-shot field rename on cutover — flagged in Risks.
- SSE keep-alive shape is identical: 15s `:` comment lines, single `event: result` or `event: error`. Required for upstream proxy timeout behavior parity with the current dashboard experience.

**New backend dependency:** add `posthog-node` to `package.json`. Backend has no PostHog wiring today.

**Env vars (new server-side):**

- `BUILDER_OPENROUTER_API_KEY` — separate from any future runtime spend key so builder's OpenRouter usage is attributable in invoices.
- `BUILDER_MODEL` — defaults to whatever `pool/src/services/skillGen.ts` uses today (`@preset/assistants-pro`).
- `EXA_SERVICE_KEY` — required by the lifted URL-extraction path in `skillGen.ts:83`. Same value as pool's existing key.
- `POSTHOG_API_KEY` and `POSTHOG_HOST` — for the spend-event emitter.

## PR sequencing

Five PRs, each shippable on its own. The first user-facing MVP lands at PR 2 (templates + builder) — users can generate, edit, publish, and share templates without skills. Subsequent PRs add forking, skills/files, and bundling as discrete enhancements.

### PR 1 — Foundation

Migration: `Account` model only, with `acct_admin` seed embedded in SQL (`INSERT … ON CONFLICT DO NOTHING`). Lift `pool/src/lib/slug-hash.ts` (`buildSlug`, `slugHash`, `isHashedSlug`) into `convos-backend/src/utils/slug-hash.ts`. Add reserved-slug validator helper. Add `posthog-node` dependency and the builder/PostHog env vars (`BUILDER_OPENROUTER_API_KEY`, `BUILDER_MODEL`, `EXA_SERVICE_KEY`, `POSTHOG_API_KEY`, `POSTHOG_HOST`). Env vars are read **lazily** by the builder route at request time — not validated at process startup — so PR 1 can land without these values being set anywhere yet. Mount empty `agentTemplatesRouter` and `agentSkillsRouter` shells at `/api/v2/agent_templates` and `/api/v2/agent_skills`, gated on `process.env.XMTP_ENV === "dev" || process.env.XMTP_ENV === "staging"` — no routes registered yet. Tests: unit-level coverage of the slug helpers and reserved-slug validator; integration tests that the routers conditionally mount based on `process.env.XMTP_ENV` (asserting via mount registry / app router introspection — no live HTTP routes to hit yet).

**Ships:** nothing user-visible. Proves the production guard wiring is correct before any data route exists; PR 2's `404 vs response` test on `/api/v2/agent_templates/...` becomes the first true end-to-end guard check.

### PR 2 — Templates MVP (first shippable user-visible release)

Migration: `AgentTemplate` + `PublishStatus` enum + indexes (`@@unique([ownerAccountId, slug])`, `@@index([slug])`, `[status, createdAt, id]`, `[status, category, createdAt, id]`, `[status, featured, createdAt, id]`, `forkedFromId`).

Routes:

- `GET /agent_templates` (public; `status = published` only by default; filters: `category`, `owner`, `featured`).
- `GET /agent_templates/{id_or_hashed_slug}` (public; resolves for `published`/`unlisted`/`archived`; 404 for `draft`; `?expand[]=owner` works, `skills`/`skills.files` return empty until PR 5).
- `POST /agent_templates` (server pins `status=draft`, `version=1`, `firstPublishedAt=null` regardless of body. `slug` is optional in the body — if omitted, server auto-derives it from `agent_name` via `slugify` + per-owner collision-suffix retry, mirroring pool's existing pattern. Supplied or derived slug runs through reserved-slug + slug-regex validation).
- `PATCH /agent_templates/{id}` (content fields + slug pre-publish + post-publish status transitions; reserved-slug check on slug; `draft → *` rejected — first publish must go through `/publish`).
- `DELETE /agent_templates/{id}` (rejects when `firstPublishedAt IS NOT NULL` — published rows must be archived via PATCH instead).
- `POST /agent_templates/{id}/publish` (first publish: sets `firstPublishedAt`, leaves `version=1`, flips `status` to `published` or `unlisted` if `?status=unlisted`. Subsequent: increments `version`, leaves status alone).
- `POST /agent_templates/generate` (the **builder** — SSE; lifts `pool/src/services/skillGen.ts` + `pool/data/skill-generator-prompt.txt`. snake_case response. PostHog event per generation with `request_id`, `auth_mode`).

Tests: full template state machine, slug uniqueness/validation/immutability/reserved-rejection, slug auto-derivation from `agent_name` when body omits it, hashed-slug multi-owner resolution, server-pins-create-fields, DELETE-rejects-published, PATCH-rejects-draft-transitions, builder SSE keep-alive on staging, **first true end-to-end production-guard verification** (live HTTP request against `/api/v2/agent_templates` returns the expected route handler in `dev`/`staging` and 404s in `production`/unset/unknown).

**Ships:** end-to-end usable templates surface. A user can generate a template via builder, edit, publish to gallery, share via hashed-slug URL. No skills bundled yet — but a template with `prompt + tools + connections + avatar` describes a usable agent on its own. Pool's `/api/skills/generate` and `/api/proxy/skills/generate` stay live; the runtime workstream handles cutover.

### PR 3 — Forking (shippable enhancement)

Adds template fork. **Shallow fork at this stage** — copies the source template's content fields and `forkedFromId`, but no bundled skills (skills don't exist yet). Becomes a deep fork in PR 5 when bundling lands.

Routes:

- `POST /agent_templates/{id}/fork` (allowed on any source `status` except `draft`; auto-generates fork slug per the fork-slug strategy or accepts `{ "slug": "<override>" }`; new template starts at `version=1`, `status=draft`, `firstPublishedAt=NULL`).

Tests: fork-slug auto-generation including conflict suffix incrementation, fork from archived sources, fork from unlisted, fork rejected from draft, and direct-DB referential-action verification — `forkedFromId` cleared to NULL when a _draft_ parent is hard-deleted (Prisma default `SetNull`). Note: `DELETE /agent_templates/{id}` rejects on published parents (must archive instead), so the SetNull path is only reachable when a draft template with forks is hard-deleted.

**Ships:** users can fork any non-draft template into their own draft. Existing forks made before PR 5 stay shallow forever (their `AgentTemplateSkill` set is empty, just like the source's was at the time).

### PR 4 — Skills + versioned files

Migration: `AgentSkill` + `AgentSkillFile` + indexes. Cascade rule: `AgentSkillFile.skill: onDelete: Cascade`.

Routes:

- All `/agent_skills` CRUD (`GET` list/detail, `POST`, `PATCH`, `DELETE`). DELETE only enforces the published-row rejection in this PR; the bundled-by-any-template rejection lands in PR 5 when `AgentTemplateSkill` exists.
- Bulk `PUT /agent_skills/{id}/files` (atomic replace).
- Per-path `PUT/DELETE /agent_skills/{id}/files/{path*}` with clone-on-first-mutation transactional behavior.
- `POST /agent_skills/{id}/publish` (validates `SKILL.md` exists at the publishing version; sets `lastPublishedVersion`; first-publish auto-flip).
- `POST /agent_skills/{id}/fork` (standalone skill fork; auto-gen slug; new skill is `draft`).

Tests: file-write limits on both bulk and per-path; clone-on-first-per-path-mutation under concurrent writers; bulk replace post-publish creates a new draft without overwriting frozen rows; SKILL.md publish rejection; status state machine on PATCH; DELETE rejects published rows; fork from non-draft sources.

**Ships:** standalone skill gallery. Skills are usable as standalone resources — bundling into templates lands in PR 5.

### PR 5 — Bundling + deep template fork

Migration: `AgentTemplateSkill` + indexes. Cascade rules: template→Cascade, skill→Restrict (defense in depth matching the route-layer rejection).

Routes:

- `POST /agent_templates/{id}/skills` (bundle, body `{ "skill", "skill_version"? }`; idempotent repin; rejects archived/never-published skills).
- `DELETE /agent_templates/{id}/skills/{skill_id}` (unbundle).
- `GET /agent_skills/{id}/templates` (reverse lookup; parent must satisfy direct-read; returned templates filtered to `published`).
- `?expand[]=skills` and `?expand[]=skills.files` on `GET /agent_templates/{id_or_hashed_slug}` — files returned at each join row's pinned `skillVersion`, NOT the skill's current `lastPublishedVersion`.

**Upgrades** template fork from shallow to deep: forks now also create owner-scoped forked skills (`unlisted`, `lastPublishedVersion=1`, slug from auto-gen or `{ "skill_slugs": {…} }` override) and bundle them on the new template at v1. **Also extends `DELETE /agent_skills/{id}`** to reject when any `AgentTemplateSkill` references the skill (the bundled-by-template clause that was a no-op in PR 4).

Tests: pinned-version expand returning the bundle that would deploy (not the skill's latest), deep fork copying files at the source's pinned `skillVersion`, archived-source-fork allowed, repin idempotency, reverse-lookup leak guard, bundle rejected when skill never published, cascade on template delete leaves `AgentSkill` untouched.

**Ships:** full templates+skills composability. Templates can bundle skills, skills can be reused across templates, deep fork gives users their own owner-scoped copies of the whole bundle.

### Summary

| PR  | Lands                   | Cumulative user value                                |
| --- | ----------------------- | ---------------------------------------------------- |
| 1   | Foundation, no routes   | Nothing                                              |
| 2   | Templates + builder     | **MVP shippable** — generate, edit, publish, gallery |
| 3   | Template fork (shallow) | Remix any non-draft template                         |
| 4   | Skills + files          | Standalone skill gallery                             |
| 5   | Bundling + deep fork    | Full composability; fork = full owned copy           |

PR 2 is the only PR that ships both schema and a long-running route (the builder SSE) at once; isolating it from later PRs means the SSE proxy-timeout risk is concentrated in the MVP launch and does not block forking, skills, or bundling. The shallow-then-deep fork transition between PR 3 and PR 5 is intentional — old forks stay shallow (no skills to copy at the time), new forks at PR 5+ become deep.

## What this enables for downstream workstreams

- **Auth (SIWE):** drops in `AuthMethod`, `XmtpInbox`, `Profile`. The transitional `acct_admin` short-circuit becomes a real-account resolver. No template/skill schema change.
- **Credits:** drops in `CreditBalance`, `CreditLedger`, `GrantKind`, plus `/accounts/me/credits/*` and `/agents/credits/*`. Builder swaps PostHog-only metering for a `CreditLedger` consume call.
- **New claiming backend:** owns `AgentInstance` (or its equivalent). At deploy, snapshots `(prompt, tools, connections, avatarUrl, [(skillId, skillVersion), ...])` from the live `AgentTemplate` row onto the instance — that snapshot is the source of immutability for live instances. Reads `AgentSkillFile` rows by `(skillId, skillVersion)` for runtime materialization.
- **Runtime skill materialization:** consumes `AgentSkillFile` rows directly. Owns the on-disk layout contract (`SKILL.md` + `references/...`); may relax the file-write limits this plan ships once it has its own materialization story.

## Risks

- **Builder SSE proxy timeouts.** convos-backend's existing routes are short-request. The builder is the first long-lived path. Whatever proxy fronts the service needs `Connection: keep-alive` and a generous read timeout. Verify on staging before merging PR 2.
- **Pre-production only until auth lands.** This slice does not ship to production until real accounts + SIWE land. Dev/staging is fine because anything authored pre-auth is admin-owned by definition. If auth slips, this plan slips with it — it does not unlock standalone.
- **Builder response casing change.** Pool's generator returns camelCase (`agentName`, …); the new backend builder returns snake_case to match v2 conventions. The dashboard's create flow and the runtime's `assistant-builder` skill both consume the result and will need a one-shot field rename when the builder cuts over. Track in the runtime + dashboard repoint PRs.
- **Pool stays live during transition.** Pool's `/api/skills/*` and `/api/proxy/skills/*` routes remain operational until the runtime workstream cuts over. This plan does not touch pool. The runtime's `assistant-builder` skill keeps calling pool until that workstream lands; nothing breaks if that lag is months.
- **Pool's** `agent_skills` **deprecation.** Downstream — the dashboard, runtime `assistant-builder` skill, and pool admin all read pool's `/api/skills` today. Each repoint is its own PR; coordinate the cutover with the new claiming backend so pool can be retired in one window.

## Open questions (resolved going in)

- **File-version model:** versioned `AgentSkillFile` (immutable rows tagged with `skillVersion`), not copy-on-publish into a snapshot table.
- **PR-1 schema scope:** smallest viable subset (Account only). Other workstreams add their own tables in their own migrations.
- **Builder spend metering:** PostHog event only for now; swap to `CreditLedger` consume when credits ships.
- `connections` **field shape:** `String[]` with prefix convention (`composio:<slug>`, `apple_health`, …). Validated by a Zod enum-with-passthrough — unknown prefixes log a warning rather than 400, so non-Composio additions don't require a backend release.
- **Authorization until SIWE:** every owner is `acct_admin`. Writes accept either the existing JWT (any authed device) or `X-Agent-API-Key`; reads are public. No per-row author tracking, no admin allowlist. This slice does not ship to production until real accounts land.
- **Builder OpenRouter spend caps.** The builder's OpenRouter API key has its own credit limit at the OpenRouter side. No in-app circuit breaker needed.
- **Slug DB shape vs URL form.** DB uniqueness is per-owner (`@@unique([ownerAccountId, slug])`). URL form is `<slug>.<hash5>` derived from the row id, lifted from pool's `lib/slug-hash.ts` so the convention is identical.
- **File write limits.** Tight per-file (256 KB) and per-skill (64 files / 4 MB) caps in this plan. Runtime materialization workstream may relax them once it owns the on-disk contract.
- **Public reads.** Direct lookup (`/{type}/{id_or_slug}`) resolves for `published | unlisted | archived`; 404 for `draft`. List endpoints return only `published` rows; `?status=` is rejected pre-SIWE. File reads always return `lastPublishedVersion`. Per-account "view my own drafts" lands with SIWE.
