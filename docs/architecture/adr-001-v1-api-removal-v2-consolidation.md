# ADR-001: v1 API Removal and v2 Consolidation

> **Status**: Accepted
> **Author**: lourou
> **Created**: 2026-01-08
> **Updated**: 2026-01-08
> **PR**: #157

## Context

### Legacy v1 Architecture

The v1 API was built for the original Convos React Native app with a traditional identity model:

- **Backend-stored profiles**: User profiles, usernames, and metadata stored in PostgreSQL
- **XMTP identity tracking**: Backend stored XMTP inbox IDs and managed device-identity relationships
- **Server-side invites**: Invite codes, usage tracking, and notification targets stored in database

This model leaked user identity through the backend - the server knew which XMTP identities belonged to which devices, enabling correlation of users across conversations.

### New v2 Privacy-Preserving Architecture

The v2 API, built for the iOS rewrite, uses a **privacy-preserving architecture** where the backend cannot identify users:

#### Device Identification

**`deviceId`** = Apple's [`identifierForVendor`](https://developer.apple.com/documentation/uikit/uidevice/identifierforvendor)

- UUID unique to the app-device combination
- Changes if app is uninstalled and reinstalled
- Backend cannot correlate this to any real-world identity
- Used for device registration and JWT token binding

#### Client Identification

**`clientId`** = Random UUID generated client-side

- Created by iOS app for each XMTP inbox (one per Conversation on Convos)
- The mapping `clientId → XMTP inboxId` exists **only on the device**
- Backend stores `ClientIdentifier(id, deviceId)` - just the UUID and which device owns it
- Backend never stores XMTP identities

#### Optional Push Tokens

Push notification tokens are **optional**:

- If a user declines push permissions, the device registers without a `pushToken`
- The backend stores `DeviceRegistration(deviceId, pushToken: null, ...)`
- Users can use the app fully without enabling push notifications
- This means the backend has **no Apple/Google push identifier** for privacy-conscious users
- Even with push enabled, the token is device-specific and rotates, it cannot identify the user across apps or reinstalls

#### Push Notification Flow

The backend integrates with [xmtp/example-notification-server-go](https://github.com/xmtp/example-notification-server-go):

```text
┌─────────────┐     ┌──────────────────────┐     ┌────────────────┐
│ XMTP Network│────▶│ Go Notification      │────▶│ Convos Backend │
│             │     │ Server               │     │ (webhook)      │
└─────────────┘     └──────────────────────┘     └───────┬────────┘
                                                        │
                                                        ▼
                                                 ┌──────────────┐
                                                 │ APNS / FCM   │
                                                 └──────────────┘
```

1. **Go notification server** subscribes to XMTP topics (not inbox IDs)
2. When a message arrives, it calls our **webhook** (`POST /api/v2/notifications/xmtp/webhook`)
3. Our backend looks up `ClientIdentifier` to find the `deviceId`
4. We fetch `DeviceRegistration` to get the push token
5. We send push notification via APNS/FCM

**Privacy guarantee**: The webhook payload contains topic hashes, not XMTP identities. The backend routes notifications without knowing who the user is.

#### Self-Contained Invites

The v2 invite system is **entirely client-side**:

- Invites are protobuf-encoded, base64url slugs containing conversation metadata
- No server-side storage of invite codes or usage
- Backend only decodes and validates the signed invite structure
- Invite creator's identity is never stored on the backend

### Why v1 Must Be Removed

| v1 (Legacy)                   | v2 (Privacy-Preserving)                         |
| ----------------------------- | ----------------------------------------------- |
| Backend stores XMTP inbox IDs | Backend never sees XMTP IDs                     |
| Backend stores user profiles  | Profiles are client-side only                   |
| Backend tracks invite usage   | Invites are self-contained                      |
| Server can correlate users    | Server cannot identify users                    |
| 15+ database tables           | 2 tables (DeviceRegistration, ClientIdentifier) |

The v1 and v2 models are **fundamentally incompatible** - you cannot have privacy-preserving architecture while also storing identity information.

## Decision Drivers

- **Privacy model change**: v2's core design requires the backend to be identity-blind
- **Dead code elimination**: v1 unused since iOS app launch
- **Security surface reduction**: Fewer endpoints = fewer attack vectors
- **Maintainability**: One API version, one auth model, one way to do things
- **Database simplification**: 72% schema reduction

## Considered Options

### Option 1: Gradual Deprecation

**Description**: Mark v1 as deprecated, remove over several releases.

**Pros**:

- Lower-risk approach
- Time for any missed dependencies to surface

**Cons**:

- Prolongs maintenance of privacy-incompatible code
- v1 was already unused by iOS app
- No external API consumers

### Option 2: Complete Removal (Chosen)

**Description**: Delete all v1 code and database tables in a single PR.

**Pros**:

- Clean break from legacy identity model
- Immediate privacy improvement (no identity data in schema)
- Clear audit trail in single PR
- Schema reduced from 208 to 58 lines

**Cons**:

- Large PR to review
- Requires database migration

## Decision

We chose **Complete Removal** because the privacy model change makes v1 fundamentally incompatible with v2. There's no gradual path - either the backend stores identity information (v1) or it doesn't (v2).

### Database Changes

**Deleted tables** (identity-storing):

- `Device`, `DeviceIdentity`, `IdentitiesOnDevice` - stored XMTP inbox IDs
- `Profile` - stored user metadata
- `SubOrg` - Thirdweb wallet references
- `InviteCode`, `InviteCodeUse`, `InviteCodeNotificationTarget`, `InviteCodeRequest` - invite tracking

**Kept tables** (privacy-preserving):

- `DeviceRegistration(deviceId, pushToken, ...)` - push token storage
- `ClientIdentifier(id, deviceId)` - random UUID to device mapping

**Migration**: `prisma/migrations/20260106182353_remove_v1_models/`

### Authentication Consolidation

**v1 auth** (deleted): HMAC-based JWT with shared secret, backend verified XMTP signatures

**v2 auth** (kept):

- `appCheckOnlyMiddleware` - Firebase App Check for device registration
- `authMiddleware` - ES256 JWT bound to `deviceId`, rejects NSE (Notification Service Extension) tokens
- `authMiddlewareAllowNSE` - ES256 JWT allowing NSE tokens for diagnostics

### Code Removed

| Directory                | Purpose                                  | Lines  |
| ------------------------ | ---------------------------------------- | ------ |
| `src/api/v1/`            | All v1 endpoints                         | ~3,500 |
| `src/utils/xmtp.ts`      | XMTP client (backend no longer connects) | 154    |
| `src/utils/thirdweb.ts`  | Wallet creation                          | 88     |
| `src/utils/namestone.ts` | ENS resolution                           | 165    |
| `tests/*`                | v1 test suites                           | ~1,200 |

**Total**: 6,938 lines deleted, 722 added

## Consequences

### Positive

- **Privacy guarantee**: Backend cannot identify users or correlate conversations
- **Simplified schema**: 2 tables instead of 15+
- **Single auth model**: AppCheck for registration, JWT for operations
- **Cleaner codebase**: No dual-path logic

### Negative

- **No rollback**: v1 identity data deleted by migration
- **Breaking change**: Any undiscovered v1 consumers would break

### Neutral

- **Documentation**: `DEVELOPMENT.md` updated with v2-only auth model
- **CI fix**: Added `LOG_FORMAT=json` to prevent pino-pretty worker thread hanging tests on CI

## Implementation Notes

### Key Files

- `prisma/schema.prisma` - reduced to privacy-preserving models
- `src/middleware/auth.ts` - consolidated auth (AppCheck + JWT)
- `src/utils/jwt.ts` - ES256 JWT utilities
- `src/api/v2/notifications/handlers/webhook.ts` - simplified push routing

### Privacy Verification

To verify the backend stores no identity information:

```sql
-- Only tables remaining
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public';
-- Returns: DeviceRegistration, ClientIdentifier, _prisma_migrations

-- No XMTP IDs anywhere
SELECT * FROM "DeviceRegistration"; -- deviceId, pushToken, environment
SELECT * FROM "ClientIdentifier";   -- id (random UUID), deviceId
```

## References

- [PR #157](https://github.com/xmtplabs/convos-backend/pull/157): api/v1 cleanup and api/v2 refactor
- [Apple identifierForVendor](https://developer.apple.com/documentation/uikit/uidevice/identifierforvendor)
- [XMTP Push Notification Server](https://github.com/xmtp/example-notification-server-go)
- [XMTP Push Notifications Guide](https://docs.xmtp.org/chat-apps/push-notifs/pn-server)
- [Firebase App Check](https://firebase.google.com/docs/app-check)
