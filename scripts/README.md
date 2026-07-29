# Push Notification Test Scripts

Test APNS push notifications locally with these CLI utilities.

## Setup

Add these to your `.env` file:

```bash
APNS_TEAM_ID=your-team-id
APNS_KEY_ID=your-key-id
APNS_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"
APNS_BUNDLE_ID=com.yourapp.bundleid
DATABASE_URL=your-database-url
```

## Usage

### Quick Test

```bash
pnpm tsx scripts/simple-push-test.ts <userId>
```

### Advanced Test with Options

```bash
pnpm tsx scripts/test-push-notification.ts <userId> [options]
```

**Options:**

- `--title <title>` - Custom notification title
- `--body <body>` - Custom notification body
- `--silent` - Send silent notification
- `--sandbox` - Force sandbox environment
- `--production` - Force production environment

**Examples:**

```bash
# Basic test
pnpm tsx scripts/test-push-notification.ts 6bb0bd17-4dae-4749-adaf-cb4d7806a9dc

# Custom message with sandbox
pnpm tsx scripts/test-push-notification.ts 6bb0bd17-4dae-4749-adaf-cb4d7806a9dc --title "Hello" --body "Test message" --sandbox
```

## Find User IDs

```sql
SELECT u.id, d.name, d.os, d.apnsEnv
FROM "User" u
JOIN "Device" d ON u.id = d."userId"
WHERE d."pushTokenType" = 'apns' AND d."pushToken" IS NOT NULL;
```

## Common Issues

- **"APNS service not configured"** → Check `.env` variables
- **"No APNS devices found"** → User has no devices with APNS tokens
- **"BadDeviceToken"** → Push token expired, device needs to re-register
- **Environment mismatch** → Use `--sandbox` for dev builds, `--production` for App Store

---

# Apple Subscription Status Checker (`apple:sub-status`)

Read-only CLI that asks Apple's App Store Server API for the current status
of one or more auto-renewable subscriptions, by `originalTransactionId`
(`GET /inApps/v1/subscriptions/{originalTransactionId}`). It is the manual
version of what a reconcile job would do: useful for support incidents
("user says they have a sub, server says they don't"). No database access;
strictly read-only against Apple.

## Usage

```bash
pnpm apple:sub-status <originalTransactionId...> [--sandbox]
```

- Defaults to the production host (`api.storekit.apple.com`).
- `--sandbox` switches to `api.storekit-sandbox.apple.com`.
- Accepts one or more `originalTransactionId`s.
- Exits non-zero if any lookup fails (HTTP status + Apple `apiError` shown).

## Required `.env` vars

From the `# IAP Prod` block in `.env` (names only — never paste values):

```bash
APPLE_API_KEY_ID=...
APPLE_API_ISSUER_ID=...
APPLE_BUNDLE_ID=...
APPLE_API_SIGNING_KEY="..."
```

Missing vars produce an actionable error; the tool never prints env values.

## Decoding the output

Subscription `status` codes:

| Code | Meaning                                            |
| ---- | -------------------------------------------------- |
| 1    | active                                             |
| 2    | expired                                            |
| 3    | billing-retry (billing failed, Apple is retrying)  |
| 4    | grace-period (billing failed, user still entitled) |
| 5    | revoked                                            |

`autoRenewStatus`: `0` = off (will not renew), `1` = on (will renew).

`expirationIntent` (why it expired / will expire): `1` customer canceled,
`2` billing error, `3` customer declined a price increase, `4` product not
available at renewal, `5` other.

`environment` in the output is decoded from Apple's signed payloads
(`Sandbox` / `Production`).

## Sandbox vs production

TestFlight purchases live in Apple's **sandbox** environment. A sandbox
`originalTransactionId` returns HTTP 404 with `apiError=4040010`
("original transaction id not found") on the production host — retry the
same id with `--sandbox`. If it also 404s with `--sandbox`, check that the
bundle ID, environment, and API key in `.env` match the app.

---

# Apple Subscription Reconcile — allowlist pilot (`subs:reconcile`)

Reconciles local `Subscription` rows against Apple ground truth
(`GET /inApps/v1/subscriptions/{originalTransactionId}`) for an EXPLICIT
allowlist of `originalTransactionId`s. This is the write-capable sibling of
`apple:sub-status`: it maps Apple's per-item `status` enum to our
`SubscriptionStatus` (same mapping contract as verify/SSN), updates the row
through the normal repository path, and moves money ONLY through the
idempotent per-period helpers (`grantSubscriptionPeriod` /
`forfeitSubscriptionPeriod` — see `src/payments/AGENTS.md`).

```bash
# DRY-RUN (default): prints the intended changes, writes NOTHING.
pnpm subs:reconcile <originalTransactionId...>

# Execute (row update + idempotent grant/forfeit + AdminAudit row):
pnpm subs:reconcile <originalTransactionId...> --apply

# Options:
#   --env production|sandbox   pin the App Store Server API host (default:
#                              configured env first, opposite host on a
#                              4040010/4040005 not-found — TestFlight OTXs
#                              live in sandbox)
#   --actor <email>            actor recorded on AdminAudit rows (apply mode)
```

Key properties:

- **Dry-run first, always.** The dry-run reports, per id: the current row,
  what Apple answered (and from which host), the intended row update, and the
  planned ledger movement — including a prediction of whether a terminal
  forfeit will no-op because the period was never granted.
- **Idempotent.** Grants/forfeits key on `(subscription, period)`; a re-run
  no-ops. The row write is concurrency-guarded on `updatedAt` — a verify/SSN
  landing mid-run wins and the job skips.
- **Fail-safe.** Any Apple error or ambiguous response leaves the row
  untouched (`provider_unresolved`).
- **Pilot scope.** Allowlist input only — no fleet scan, no cron. The scan
  machinery lives on the unmerged branch `louis/credits-reconcile-cron`
  (commit `2b0b041`) and gets resurrected when this graduates to a recurring
  safety net.

Unlike `apple:sub-status`, this job imports the server source and therefore
needs the FULL server env (`DATABASE_URL`, the `APPLE_API_*` block,
`PAYMENTS_GRANT_PLUS_MONTHLY`, plus everything `src/config.ts` requires at
load). Run it where that env already exists (the API container, or a shell
with the server `.env`). It never prints env values. Exits non-zero when any
allowlisted id could not be fully processed.

## Finding originalTransactionIds

Read-only SQL against the backend database (placeholders — substitute real
ids when running; never commit real customer or transaction ids):

```sql
-- By subscription id(s)
SELECT id, "accountId", "originalTransactionId"
FROM "Subscription"
WHERE id IN ('<subscriptionId>', '<anotherSubscriptionId>');

-- All subscriptions for an account
SELECT id, "accountId", "originalTransactionId", provider, environment, status
FROM "Subscription"
WHERE "accountId" = '<accountId>';

-- Recent Apple sandbox subscriptions (e.g. TestFlight purchases)
SELECT id, "accountId", "originalTransactionId", status, "updatedAt"
FROM "Subscription"
WHERE provider = 'apple' AND environment = 'sandbox'
ORDER BY "updatedAt" DESC
LIMIT 20;
```
