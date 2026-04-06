# Multi-Use Invite Codes with Viral Redemption

> **Status**: Draft
> **Branch**: `feat/invite-code-multi-use`
> **Parent PR**: #183 (Invite code gating for Instant Assistant)
> **Created**: 2026-04-01

## Overview

Expand the invite code system so that codes can be redeemed a configurable number of times, and each redemption automatically generates a new invite code for the redeemer. This creates a controlled viral loop — each person who redeems a code gets their own code to share.

## Summary of Changes

### Current State (PR #183)

- `InviteCode` table has: `id`, `code`, `createdAt`, `redeemedAt`, `batchLabel`
- Codes are single-use — once `redeemedAt` is set, the code is fully consumed
- `POST /api/v2/invite-codes/redeem` accepts `{ code }`, returns `{ success: true }`
- Admin generates codes via `POST /api/v2/invite-codes/admin/generate`
- Admin lists codes via `GET /api/v2/invite-codes/admin/codes`

### Target State

- Codes have a `maxRedemptions` limit and a tracked `redemptionCount`
- Codes have an optional `name` for identification
- Redeeming a code auto-generates a new code for the redeemer (default: 5 uses)
- New endpoint to check remaining redemptions for a code
- Admin can set `maxRedemptions` and `name` when generating codes

---

## 1. Database Migration

### Schema Changes to `InviteCode`

| Column             | Type     | Default | Notes                                              |
| ------------------ | -------- | ------- | -------------------------------------------------- |
| `name`             | String?  | null    | Optional human-readable label for the code          |
| `maxRedemptions`   | Int      | 1       | How many times this code can be redeemed            |
| `redemptionCount`  | Int      | 0       | How many times this code has been redeemed so far   |
| `parentCodeId`     | UUID?    | null    | FK → InviteCode.id — the code that was redeemed to generate this one |

### New Table: `InviteCodeRedemption`

Track each individual redemption event (for auditability and the viral chain).

| Column         | Type      | Notes                                    |
| -------------- | --------- | ---------------------------------------- |
| `id`           | UUID      | Primary key                              |
| `inviteCodeId` | UUID      | FK → InviteCode.id (the code redeemed)   |
| `childCodeId`  | UUID?     | FK → InviteCode.id (the code generated for the redeemer) |
| `redeemedAt`   | Timestamp | When this redemption occurred            |

### Migration Strategy

- Add new columns to `InviteCode` with defaults so existing rows are valid:
  - `maxRedemptions` defaults to `1`
  - `redemptionCount` defaults to `0` for unredeemed, `1` for already-redeemed codes
  - `name` defaults to `null`
  - `parentCodeId` defaults to `null`
- Create `InviteCodeRedemption` table
- **Keep `redeemedAt` on `InviteCode`** for backwards compatibility — updated to the timestamp of the most recent redemption. Redemption status is now primarily derived from counts:
  - A code is "fully redeemed" when `redemptionCount >= maxRedemptions`
  - A code is "available" when `redemptionCount < maxRedemptions`
  - Individual redemption timestamps live in `InviteCodeRedemption`
  - `redeemedAt` is set/updated on each redemption for compatibility with existing queries and admin tooling
- Migrate existing redeemed codes: for each code where `redeemedAt IS NOT NULL`, set `redemptionCount = 1` and create a corresponding `InviteCodeRedemption` row.

### Updated Prisma Schema

```prisma
model InviteCode {
  id              String    @id @default(uuid()) @db.Uuid
  code            String    @unique @db.VarChar(8)
  name            String?   @db.VarChar(255)
  maxRedemptions  Int       @default(1)
  redemptionCount Int       @default(0)
  createdAt       DateTime  @default(now())
  redeemedAt      DateTime?           // kept for backwards compat — updated on each redemption
  batchLabel      String?   @db.VarChar(255)
  parentCodeId    String?   @db.Uuid
  parentCode      InviteCode?  @relation("CodeLineage", fields: [parentCodeId], references: [id])
  childCodes      InviteCode[] @relation("CodeLineage")
  redemptions     InviteCodeRedemption[] @relation("CodeRedemptions")
  generatedFrom   InviteCodeRedemption[] @relation("GeneratedCode")

  @@index([batchLabel])
  @@index([redeemedAt])
  @@index([parentCodeId])
}

model InviteCodeRedemption {
  id           String     @id @default(uuid()) @db.Uuid
  inviteCodeId String     @db.Uuid
  inviteCode   InviteCode @relation("CodeRedemptions", fields: [inviteCodeId], references: [id])
  childCodeId  String?    @db.Uuid
  childCode    InviteCode? @relation("GeneratedCode", fields: [childCodeId], references: [id])
  redeemedAt   DateTime   @default(now())

  @@index([inviteCodeId])
  @@index([childCodeId])
}
```

---

## 2. API Changes

### 2a. `POST /api/v2/invite-codes/redeem` — Updated

**Request body** (unchanged):
```json
{ "code": "XKQBWFMR" }
```

**Success response** (`200`) — **updated to include generated code**:
```json
{
  "success": true,
  "data": {
    "inviteCode": {
      "code": "HTYNLBKW",
      "name": null,
      "maxRedemptions": 5,
      "redemptionCount": 0,
      "remainingRedemptions": 5
    }
  }
}
```

**Logic changes:**
1. Look up the code
2. Check `redemptionCount < maxRedemptions` (replaces the `redeemedAt == null` check)
3. Atomically increment `redemptionCount` (use `updateMany` with `where: { code, redemptionCount: { lt: maxRedemptions } }` to prevent races)
4. Generate a new invite code with `maxRedemptions = 5` (configurable default via env `DEFAULT_CHILD_CODE_MAX_REDEMPTIONS`)
5. Create an `InviteCodeRedemption` row linking the redeemed code to the child code
6. Return the generated code in the response

**Error responses** (unchanged error codes for backwards compatibility):

| HTTP status | Error code              | Meaning                                                |
| ----------- | ----------------------- | ------------------------------------------------------ |
| 404         | `CODE_NOT_FOUND`        | No code exists with that value                         |
| 409         | `CODE_ALREADY_REDEEMED` | Code exists but has reached its max redemptions        |
| 422         | `CODE_INVALID_FORMAT`   | Malformed code string                                  |
| 401         | —                       | Invalid or missing JWT                                 |

> Note: We keep `CODE_ALREADY_REDEEMED` as the error code even though a code can now be redeemed multiple times. The meaning is "this code has already been fully redeemed" — semantically close enough, and avoids a breaking change for existing iOS clients.

### 2b. `GET /api/v2/invite-codes/:code/status` — New Endpoint

Check the remaining redemptions for a given invite code.

**Authentication**: Requires a valid JWT (same as redeem).

**Response** (`200`):
```json
{
  "success": true,
  "data": {
    "code": "XKQBWFMR",
    "name": "Jarod's invite",
    "maxRedemptions": 5,
    "redemptionCount": 2,
    "remainingRedemptions": 3
  }
}
```

**Error responses:**

| HTTP status | Error code       | Meaning                               |
| ----------- | ---------------- | ------------------------------------- |
| 404         | `CODE_NOT_FOUND` | No code exists with that value        |
| 422         | `CODE_INVALID_FORMAT` | Malformed code string            |
| 401         | —                | Invalid or missing JWT                |

### 2c. `POST /api/v2/invite-codes/admin/generate` — Updated

**Request body** — add optional fields:
```json
{
  "count": 10,
  "batchLabel": "beta-wave-2",
  "name": "VIP invite",
  "maxRedemptions": 20
}
```

| Field            | Type    | Default | Notes                                       |
| ---------------- | ------- | ------- | ------------------------------------------- |
| `count`          | Int     | —       | Required, 1–500                             |
| `batchLabel`     | String? | null    | Optional batch label                        |
| `name`           | String? | null    | Optional name applied to all generated codes|
| `maxRedemptions` | Int?    | 1       | Max redemptions for each generated code     |

### 2d. `GET /api/v2/invite-codes/admin/codes` — Updated

Add new fields to the response objects:

```json
{
  "id": "...",
  "code": "XKQBWFMR",
  "name": "VIP invite",
  "status": "available",
  "maxRedemptions": 20,
  "redemptionCount": 7,
  "remainingRedemptions": 13,
  "batchLabel": "beta-wave-2",
  "createdAt": "...",
  "parentCode": "ABCDEFGH"
}
```

**Status values** — the list endpoint returns **both** old and new status representations for backwards compatibility:
- `status`: keeps the original values `"pending"` / `"redeemed"` (derived: `redeemed` if `redemptionCount >= maxRedemptions`, `pending` otherwise)
- `redeemedAt`: kept — set to the most recent redemption timestamp (or `null`)
- New additive fields: `maxRedemptions`, `redemptionCount`, `remainingRedemptions`, `name`, `parentCode`

The admin page filter continues to use `pending`/`redeemed` — no breaking change.

---

## 3. Admin Page Updates

Update the admin HTML page (`admin-page.ts`) to:

- Show new columns: Name, Max Redemptions, Redemption Count, Remaining, Parent Code
- Status filter keeps `all`, `pending`, `redeemed` (no change — semantics remain the same)
- Add `name` and `maxRedemptions` inputs to the generate form
- Widen table layout to accommodate new columns

---

## 4. Rate Limiting

- The existing `inviteCodeRedeemLimiter` (5 attempts / 15 min / IP) stays
- The new status endpoint should share the same rate limiter (it's lightweight but shouldn't be abused)

---

## 5. File-by-File Change List

| File | Change |
|------|--------|
| `prisma/schema.prisma` | Add `name`, `maxRedemptions`, `redemptionCount`, `parentCodeId` to `InviteCode`; keep `redeemedAt`; add `InviteCodeRedemption` model |
| `prisma/migrations/2026XXXX_multi_use_invite_codes/migration.sql` | New migration: alter `InviteCode` (add columns), create `InviteCodeRedemption`, backfill `redemptionCount` from existing `redeemedAt` |
| `src/api/v2/invite-codes/handlers/redeem.ts` | Rewrite redemption logic: check `redemptionCount < maxRedemptions`, atomic increment, generate child code, create redemption row, return child code |
| `src/api/v2/invite-codes/handlers/status.ts` | **New file** — handler for `GET /:code/status` |
| `src/api/v2/invite-codes/handlers/generate.ts` | Accept `name` and `maxRedemptions` in body schema; pass to `createMany` |
| `src/api/v2/invite-codes/handlers/list.ts` | Add new additive fields to response; keep existing `status`/`redeemedAt` fields for compat |
| `src/api/v2/invite-codes/handlers/admin-page.ts` | Update HTML to show new columns, new filter options, new generate form fields |
| `src/api/v2/invite-codes/invite-codes.router.ts` | Add `GET /:code/status` route |
| `src/api/v2/index.ts` | No changes needed (router already mounted) |
| `tests/invite-codes.test.ts` | Update existing tests, add tests for: multi-use redemption, child code generation, status endpoint, exhausted codes |

---

## 6. Implementation Order

1. **Migration** — schema changes + data migration
2. **Generate handler** — accept `name` and `maxRedemptions`
3. **Redeem handler** — multi-use logic + child code generation
4. **Status handler** — new endpoint
5. **List handler** — updated response shape
6. **Admin page** — updated HTML
7. **Tests** — update + expand
8. **Router wiring** — add status route

---

## 7. Open Questions

- [ ] Should the default child code `maxRedemptions` (5) be configurable per parent code, or always a global default?
- [ ] Should the status endpoint return redemption history (list of timestamps), or just the counts?
- [ ] Should there be a way to revoke/disable a code without deleting it? (e.g., `disabled` boolean)
- [ ] What should happen if code generation during redemption fails? Should the redemption still succeed (without a child code), or should the whole thing roll back?
- [x] ~~Should the `CODE_ALREADY_REDEEMED` → `CODE_FULLY_REDEEMED` rename be coordinated with an iOS release?~~ **Resolved: keep `CODE_ALREADY_REDEEMED` for backwards compatibility.**

---

## 8. Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Race condition on `redemptionCount` increment | High | Use atomic `updateMany` with `where: { redemptionCount: { lt: maxRedemptions } }` — same pattern as current `redeemedAt: null` check |
| Migration on existing data | Medium | Backfill `redemptionCount` from `redeemedAt`; keep `redeemedAt` column; run in transaction |
| ~~Breaking change for iOS~~ | ~~Medium~~ | **Resolved**: keeping `CODE_ALREADY_REDEEMED` error code and `pending`/`redeemed` status values; all new fields are additive |
| Child code generation failure during redemption | Low | Wrap redemption + child creation in a transaction; roll back both on failure |
| Unbounded viral chain depth | Low | Not a concern at 5 uses per child; monitor via `parentCodeId` lineage if needed |
