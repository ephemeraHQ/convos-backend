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
