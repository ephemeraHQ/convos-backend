# Android Device Registration: Device ID Validation Plan

## Context

Current backend request schemas validate `deviceId` as a UUID. This works for iOS (`identifierForVendor`) but fails for Android values such as `ANDROID_ID` (64-bit hex string) and would also reject Firebase Installation ID (FID) values.

Engineering discussion aligned on:
- Backend should become more permissive for `deviceId`.
- Android should move from `ANDROID_ID` to Firebase Installation ID (FID) for better privacy properties.
- App Check remains the primary app authenticity control.

## Decision

1. Replace strict UUID validation for `deviceId` with bounded string validation.
2. Keep iOS behavior unchanged (IDFV still accepted).
3. Android app migrates to FID as the `deviceId` source.

## Backend Changes

### Validation
Use a shared schema for `deviceId`:
- `z.string().trim().min(1).max(128)`

Apply it in:
- `src/api/v2/device/handlers/register.ts`
- `src/api/v2/auth/handlers/generate-token.ts`
- `src/api/v2/notifications/handlers/subscribe.ts`
- `src/utils/jwt.ts` payload validation (`deviceId`)

`clientId` remains UUID-validated.

### Data Layer
No DB migration required now:
- Prisma stores `deviceId` as `String`/`TEXT`.

Optional hardening follow-up:
- Add DB check constraint for max length (e.g. `char_length(deviceId) <= 128`).

## Android Changes

- Replace `deviceId` source from `ANDROID_ID` to Firebase Installation ID.
- Ensure the same value is used consistently for:
  - `/v2/device/register`
  - `/v2/auth/generate-token`
  - `/v2/notifications/subscribe`

## Rollout Plan

1. Deploy backend validation change first (backward-compatible).
2. Release Android app update using FID.
3. Monitor request failures and success rates.

## Test & Verification

- iOS UUID `deviceId` accepted end-to-end.
- Android legacy hex `ANDROID_ID` accepted during migration.
- Android FID accepted.
- Overlong `deviceId` (>128) rejected with 400.
- JWT ownership checks still valid (`deviceId` string equality).
- Register -> generate-token -> subscribe flow succeeds on both platforms.

## Observability

Track:
- 400 rate for device-related endpoints.
- Device register success rate.
- Token generation success rate.
- Topic subscribe success rate.

## Follow-up

After Android migration stabilizes, decide whether to:
- support legacy Android IDs indefinitely, or
- tighten accepted patterns/charset once all active clients use FID.
