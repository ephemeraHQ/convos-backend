# Engineering Design: Accept `generationId` on `POST /v2/agents/join` (convos-backend)

## 1. Summary

To let agent provisioning run in parallel with LLM template generation, the
iOS builder flow will call `POST /v2/agents/join` with a `generationId` instead
of waiting for generation to finish and passing a `templateId`. This spec covers
the **convos-backend** half of that change only: make the join handler accept
`generationId` as an alternative to `templateId`, validate the generation row's
existence and ownership, dispatch the assistant workflow **without** a resolved
template (forwarding `generationId` downstream), and confirm the existing
`GET /v2/agent-templates/:id` endpoint already serves any-status templates to the
agent-API-key caller so the workflow can resolve the generated template later. The
change is purely additive — the existing `templateId` and bare-join paths are
untouched.

## 2. Project Goals & Non-Goals

### Goals

- `POST /v2/agents/join` SHALL accept `generationId` (a UUID) as an alternative
  to `templateId`, dispatching the assistant workflow with `template: null` and a
  forwarded `generationId`.
- The handler SHALL validate that the supplied `generationId` references an
  existing generation row owned by the joining user, returning `404`/`403`
  respectively otherwise — so a bad or foreign id fails at join time rather than
  stranding a provisioned agent.
- The `agent-builder` onboarding option, which is rejected when combined with
  `templateId`, SHALL be permitted (and is the expected pairing) when combined
  with `generationId`.
- `templateId` and `generationId` SHALL be mutually exclusive ("at most one").
- The direct-add registration-poll phase (`pollUntilRegistered` → return
  `{instanceId, inboxId}`) SHALL be unchanged — registration does not depend on a
  template.
- Confirm and lock in (with a regression test) that `GET /v2/agent-templates/:id`
  already serves a **draft** template to a caller presenting the agent API key
  (`isApiKeyListener`), so the convos-assistants workflow can resolve the
  generated template by id regardless of its `publishStatus` at the moment
  generation completes. **No new endpoint is added.**

**Invariants that must hold:**

- The `dispatchBodySchema` is `.strict()`: a `generationId` field must be added to
  it or every gen-ID dispatch 500s. This is the existing deliberate forcing
  function (`join.ts:144`).
- An agent is never provisioned without an `ownerAccountId` (the pre-#231
  ownerless-agent bug class). `ownerAccountId` continues to be the joining user's
  account id on every path.

### Non-Goals

- **convos-assistants workflow changes** (poll-for-preview, poll-for-done,
  `buildJoinIdentity` refactor, the convos-API client, container pre-start). Being
  worked in parallel; out of scope here.
- **convos-ios changes** (reorder `drive`, models, protocol, mocks).
- **Orphaned-member cleanup on generation failure** (plan §5.6 / open decision
  #3). The failure transition is owned by the assistants workflow; backend-driven
  cleanup is a separate follow-up, explicitly out of scope.
- **A new `/internal/agent-templates/:id` endpoint.** The plan recommended one as
  a hedge against draft-visibility timing; exploration shows the existing endpoint
  already covers the keyed-worker case, so it is not built.
- The backend does **not** itself poll the generations API during join — that is
  the workflow's job. The backend only forwards `generationId`.

## 3. Context

### Catalysts

- Source design doc: `convos-ios/docs/plans/generation-id-join.md` (§4 is the
  backend slice; §7 PR plan item 1 is this work).

### Codebase

- `src/api/v2/agents/handlers/join.ts` — the join handler (primary impact).
- `src/api/v2/agents/lib/build-join-payload.ts` — template→wire transform (used
  only on the `templateId` path; untouched).
- `src/api/v2/agents/handlers/assistant-config.ts` — config getters + test seam.
- `src/api/v2/agents/agents.router.ts` — mounts `join` behind
  `authMiddleware`/`requireAccount`.
- `src/api/v2/agent-templates/handlers/detail.ts` — `GET /v2/agent-templates/:id`;
  serves drafts to owner **or** API-key listener (`:64-84`).
- `src/api/v2/agent-templates/agent-templates.router.ts` — mounts detail under
  `optionalAuthOrAgentApiKeyAuth` (`:97-101`).
- `src/middleware/agentAuth.ts` — `optionalAuthOrAgentApiKeyAuth` sets
  `res.locals.isApiKeyListener = true` for agent-API-key callers (`:166-175`).
- `prisma/schema.prisma` — `AgentTemplateGeneration` model (`:213-272`); status
  enum `pending|running|done|failed` (`:206-211`); `ownerAccountId` (`:215`),
  `templateId?` (`:256`), `preview?` (`:251`). **No `conversationId` column.**
- `src/api/v2/agent-templates/handlers/generations-post.ts:718-753` — establishes
  that authenticated (JWT) builder submissions are owned by the real user account
  (`getEffectiveOwnerId`), anonymous by `ADMIN_ACCOUNT_ID`.

### Impact area

- `src/api/v2/agents/handlers/join.ts` (schemas + resolution branch + dispatch
  body build).
- `tests/agents-join.test.ts` (new scenarios).
- `tests/` — a regression test asserting the API-key listener can fetch a draft
  template (anchors the workflow's resolution path).

### Existing behavior at risk

These behaviors in the impact area MUST continue working unchanged:

- **Bare join** (no template, no generation): dispatches `template: null`, forwards
  `ownerAccountId`. Covered by `tests/agents-join.test.ts:718-741`.
- **`templateId` resolution + publishStatus policy**: published/unlisted joinable
  by anyone; draft joinable by owner only (403 otherwise); archived → 410; not
  found → 404; lookup throw → 500. Covered `tests/agents-join.test.ts:743-899`.
- **`templateId` + `onboarding=agent-builder` → 400**: the existing mutual
  exclusion. Covered `:901-914`. Must remain — only the _generationId_ pairing is
  newly allowed.
- **Exactly-one-of slug/conversationId** invariant. Covered `:300-320`.
- **Direct-add registration poll** returns `{instanceId, inboxId}` /
  null-pending. Covered `:179-298`.
- **`name`/`profileImage` override spread** onto the resolved template. Covered
  `:780-813`. On the generationId path there is no template to spread onto.
- **`GET /v2/agent-templates/:id` draft visibility** to owner / API-key listener
  / public-for-published. Covered by the detail handler's existing tests.

### Brownfield gap analysis

| Module           | Path                                             | Public interface the change conforms to / extends                                                                                | Existing tests (verification anchors)            |
| ---------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Join handler     | `src/api/v2/agents/handlers/join.ts`             | `bodySchema` (`:71`), `dispatchBodySchema` (`:144`), `joinHandler` (`:343`), `__setTemplateFinderForTests` (`:29`)               | `tests/agents-join.test.ts` (whole file)         |
| Assistant config | `src/api/v2/agents/handlers/assistant-config.ts` | `getAssistantApiUrl/Key`, `getJoinWaitBudgetMs/PollIntervalMs`, `assistantStatusSchema`, `__setAssistantConfigOverridesForTests` | exercised throughout `tests/agents-join.test.ts` |
| Template detail  | `src/api/v2/agent-templates/handlers/detail.ts`  | `detailHandler`; draft visible to `isApiKeyListener` (`:75-81`)                                                                  | detail handler test suite                        |
| Generation model | `prisma/schema.prisma:213-272`                   | `prisma.agentTemplateGeneration.findUnique`                                                                                      | —                                                |

## 4. System Design

### Architecture overview

The change is localized to `joinHandler`. Today the handler has a single
template-resolution branch keyed on `templateId`. We add a parallel, mutually
exclusive branch keyed on `generationId` that validates the generation row but
resolves **no** template, leaving `resolvedTemplate = null` and forwarding
`generationId` in the dispatch body.

```
POST /v2/agents/join { conversationId, generationId, options:{onboarding:"agent-builder"} }
  │
  ├─ bodySchema: at-most-one(templateId, generationId); exactly-one(slug, conversationId)
  ├─ if templateId+agent-builder  → 400 (unchanged)
  │   (generationId+agent-builder  → ALLOWED)
  │
  ├─ if templateId present:  resolve template + publishStatus policy   (unchanged)
  ├─ else if generationId present:
  │     row = agentTemplateGeneration.findUnique({ where:{ id }})
  │       null                              → 404 GENERATION_NOT_FOUND
  │       row.ownerAccountId !== caller     → 403 GENERATION_FORBIDDEN
  │       (do NOT resolve a template; resolvedTemplate stays null)
  │
  ├─ build dispatch body:
  │     template: joinPayload?.template ?? null      (null on gen-ID path)
  │     generationId: <set on gen-ID path, else omitted>
  │     ownerAccountId: caller
  │  dispatchBodySchema(.strict()): now includes generationId
  │
  └─ POST {assistant}/api/assistants → poll (direct-add: pollUntilRegistered)
         → { instanceId, inboxId }                    (unchanged)

Later, asynchronously (convos-assistants, OUT OF SCOPE):
  workflow polls GET /v2/agent-templates/generations/:id (preview, then done→templateId)
  workflow GET /v2/agent-templates/:templateId with X-Agent-API-Key
       → detail.ts serves it (draft OK for isApiKeyListener)   ← this spec only CONFIRMS this works
```

### New or modified interfaces

**`bodySchema` (`join.ts:71`)** — add field + refinement:

```ts
generationId: z.string().uuid().optional(),
// existing fields unchanged …
.refine(at-most-one(templateId, generationId), {
  message: "Provide at most one of templateId or generationId",
  path: ["generationId"],
})
```

**`dispatchBodySchema` (`join.ts:144`)** — add field (`.strict()` forces this):

```ts
generationId: z.string().uuid().optional(),
// template stays z.record(...).nullable()
```

**New error constants** (alongside `ERRORS` / inline, mirroring template policy):

- `404 GENERATION_NOT_FOUND` — "Generation not found"
- `403 GENERATION_FORBIDDEN` — "Not authorized to use this generation"
- `500 GENERATION_LOOKUP_FAILED` — "Failed to load generation" (DB throw)

### Key functions

- **`joinHandler` resolution branch**: introduce an `else if (generationId !==
undefined)` arm after the existing `if (templateId !== undefined)` block
  (`:465-541`). It performs `prisma.agentTemplateGeneration.findUnique({ where: {
id: generationId } })` inside a try/catch (DB throw → 500
  `GENERATION_LOOKUP_FAILED`, mirroring the templateId catch at `:468-479`); null
  row → 404; `row.ownerAccountId !== joiningUserAccountId` → 403. It does **not**
  read `row.status` or `row.templateId` — the generation may still be `pending`,
  which is the whole point. `resolvedTemplate` remains `null`.

  _Owner-check soundness:_ authenticated builder submissions are owned by the real
  user account (`generations-post.ts:753`), so for the normal JWT-authenticated
  iOS builder flow `row.ownerAccountId === joiningUserAccountId`. (Anonymous
  generations owned by `ADMIN_ACCOUNT_ID` are not part of the builder-join flow;
  they would 403, which is correct — a different account cannot adopt them.)

  Following the established test-seam pattern (`__setTemplateFinderForTests`,
  `:29`), add a `__setGenerationFinderForTests` seam so the generation lookup can
  be injected in tests without a live DB.

- **`agent-builder` gate generalization (`:446-457`)**: the existing rejection
  fires only for `templateId + agent-builder`. Leave that exactly as-is; the
  `generationId + agent-builder` combination simply never hits it, so it is
  allowed with no code change to the gate beyond confirming the condition keys on
  `templateId !== undefined` (it already does).

- **Dispatch body build (`:591-603`)**: add `generationId` to `dispatchBody` when
  present. On the gen-ID path `templateWithOverrides` is `null` (no template to
  spread `name`/`profileImage` onto), so `joinPayload` is `null` and `template`
  serializes to `null` — already the bare-join behavior.

### Alternatives considered

- **New `GET /internal/agent-templates/:id` behind a dedicated bearer token**
  (plan §5.5/5.6 recommendation, modeled on credits-admin #321
  `makeBearerTokenAuth`). Rejected: `detail.ts:64-84` already serves drafts to
  `isApiKeyListener`, and `optionalAuthOrAgentApiKeyAuth` already sets that flag
  for the agent-API-key caller the workflow uses. A new route + middleware + token
  provisioning would duplicate an existing, tested capability. The hardening value
  (revoking the workflow's broad agent-API-key reach) is real but not needed for
  this feature and can be a later follow-up.

- **Validate the generation's `conversationId` matches the join's
  `conversationId`.** Rejected: the `AgentTemplateGeneration` model has no
  `conversationId` column (`schema.prisma:213-272`), so this binding does not
  exist to check. Owner-equality is the available and sufficient guard.

- **Resolve the generation's `templateId` eagerly when the row is already
  `done`.** Rejected: couples the handler to generation timing, reintroduces the
  serialization the feature removes, and the workflow already resolves the
  template itself. The backend stays template-agnostic on this path.

## 5. Libraries & Utilities Required

**External dependencies:** None.

**Internal modules:**

| Module            | Path                   | Purpose                                                                                            |
| ----------------- | ---------------------- | -------------------------------------------------------------------------------------------------- |
| `prisma`          | `src/utils/prisma`     | `agentTemplateGeneration.findUnique` for the existence/owner check (already imported in `join.ts`) |
| `accountIdSchema` | `src/utils/account-id` | already used by `dispatchBodySchema`; unchanged                                                    |

No new dependencies, no schema migration (the `AgentTemplateGeneration` model and
`detail.ts` visibility already exist).

## 6. Testing & Validation

### Acceptance Criteria

1. WHEN a join request includes a valid `generationId` owned by the caller AND a
   `conversationId` THE SYSTEM SHALL dispatch `POST {assistant}/api/assistants`
   with `template: null`, the forwarded `generationId`, and
   `ownerAccountId` = the caller's account id.
2. WHEN a join request includes `generationId` for a generation row that does not
   exist THE SYSTEM SHALL respond `404` with error `GENERATION_NOT_FOUND` and
   SHALL NOT dispatch the assistant workflow.
3. WHEN a join request includes `generationId` for a generation row whose
   `ownerAccountId` differs from the caller's account id THE SYSTEM SHALL respond
   `403` with error `GENERATION_FORBIDDEN` and SHALL NOT dispatch the workflow.
4. WHEN the generation lookup throws (DB error) THE SYSTEM SHALL respond `500` with
   error `GENERATION_LOOKUP_FAILED` and SHALL NOT dispatch the workflow.
5. WHEN a join request includes both `templateId` and `generationId` THE SYSTEM
   SHALL respond `400` with error `INVALID_REQUEST`.
6. WHEN a join request includes `generationId` AND `options.onboarding` =
   `agent-builder` THE SYSTEM SHALL accept the request (NOT respond 400) and
   forward `options.onboarding` upstream.
7. WHEN a join request includes `generationId` for a generation whose `status` is
   `pending` (no `templateId` yet) THE SYSTEM SHALL still dispatch successfully —
   it SHALL NOT read or require `row.templateId` or `row.status`.
8. WHEN a join request includes `generationId` with a `conversationId`
   (direct-add) THE SYSTEM SHALL poll for registration and respond
   `{ success: true, joined: false, instanceId, inboxId }` exactly as the
   no-template direct-add path does today.
9. THE SYSTEM SHALL include `generationId` in `dispatchBodySchema` such that a
   gen-ID dispatch body passes `.strict()` validation rather than 500ing with
   `JOIN_DISPATCH_INVALID`.
10. WHERE a caller presents a valid agent API key (`X-Agent-API-Key`) THE SYSTEM
    SHALL serve a `draft` agent template from `GET /v2/agent-templates/:id`
    regardless of the caller's account ownership of that template.

### Regression Protection

**Preserved behaviors (must NOT change):**

- THE SYSTEM SHALL CONTINUE TO dispatch a bare join (no `templateId`, no
  `generationId`) with `template: null` and the caller's `ownerAccountId`.
- THE SYSTEM SHALL CONTINUE TO resolve a `templateId`, apply the publishStatus
  policy (published/unlisted → anyone; draft → owner-only else 403; archived →
  410; not found → 404; lookup throw → 500), and ride the template as the
  top-level `template` field.
- THE SYSTEM SHALL CONTINUE TO reject `templateId` combined with
  `options.onboarding=agent-builder` with `400 INVALID_REQUEST`.
- THE SYSTEM SHALL CONTINUE TO require exactly one of `slug` or `conversationId`.
- THE SYSTEM SHALL CONTINUE TO overlay caller-supplied `name`/`profileImage` onto
  the resolved template on the `templateId` path.
- THE SYSTEM SHALL CONTINUE TO return `{ instanceId, inboxId }` (or null-pending)
  for direct-add registration.
- THE SYSTEM SHALL CONTINUE TO serve published/unlisted templates publicly and
  drafts to their owner from `GET /v2/agent-templates/:id`.

**Verification anchors (must remain green):**

- `tests/agents-join.test.ts` — entire suite, especially:
  - bare join ownerAccountId forwarding (`:718-741`)
  - templateId resolution + publishStatus policy (`:743-899`)
  - templateId + agent-builder rejection (`:901-914`)
  - templateId + first-impression composes (`:916-943`)
  - slug/conversationId exclusivity (`:300-320`)
  - direct-add registration poll (`:179-298`)
- `tests/build-join-payload.test.ts` — unchanged (gen-ID path doesn't touch
  `buildJoinPayload`).
- The detail-handler test suite covering draft visibility.

**Coverage gaps:** The "API-key listener can fetch a draft template" behavior
(AC-10) is the workflow's load-bearing assumption. If no existing detail-handler
test asserts the **draft + API-key** case specifically, add one BEFORE relying on
it, so the workflow's resolution path is anchored in convos-backend's suite.

### Edge Cases

- **`pending`/`running` generation at join time** — expected and must succeed
  (AC-7); the handler must not branch on `status`.
- **`failed`/`done` generation at join time** — also accepted at the backend; the
  backend does not gate on terminal status (cleanup/failure handling is the
  workflow's job, out of scope). The owner+existence check is the only gate.
- **Generation owned by `ADMIN_ACCOUNT_ID` (anonymous submission)** — a
  JWT-authenticated caller will 403 (not their account). Correct; documented as
  intended.
- **Both `templateId` and `generationId` absent** — bare join; unchanged.
- **Malformed `generationId` (non-UUID)** — `z.string().uuid()` → `400
INVALID_REQUEST` before any DB hit.
- **DB throw during generation lookup** — 500, no dispatch (AC-4), mirroring the
  templateId lookup-failure path so a transient DB error doesn't strand a
  provisioned agent.
- **Security**: the owner check prevents a caller from provisioning an agent bound
  to another user's in-flight generation. `generationId` is logged (it is a UUID
  reference, not a capability secret like `slug`); follow the existing sanitized
  logging at `:411-417` (log `generationId`, never `slug`).

### Verification Commands

```bash
# Single-file, fastest feedback loop:
pnpm test -- tests/agents-join.test.ts

# Detail-handler regression (draft + API-key):
pnpm test -- tests/agent-templates-detail.test.ts   # adjust to actual filename

# Full suite (DB-backed):
pnpm run test:local

# Static checks (typecheck + prettier + eslint):
pnpm run check
# or individually:
pnpm run typecheck
pnpm run lint
pnpm run format:check
```

`.strict()` on `dispatchBodySchema` makes a missed `generationId` field a 500 at
runtime; AC-9's test (assert a gen-ID dispatch body passes validation and the
upstream `POST /api/assistants` receives `generationId`) is the guard that the
schema was actually extended.
