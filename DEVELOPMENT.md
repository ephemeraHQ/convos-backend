# Local Development Setup

## Prerequisites

- Node.js 24 (see `.nvmrc`)
- pnpm 10.33.4 (provisioned via Corepack: `corepack enable && corepack prepare pnpm@10.33.4 --activate`)
- [Docker](https://www.docker.com/) for running dependencies

## Quick Start

1. **Start Docker services** (PostgreSQL, XMTP node, notification server):

   ```bash
   ./dev/up
   ```

2. **Configure environment** - copy `.env.example` to `.env` and generate keys:

   ```bash
   # Generate JWT ECDSA key pair
   pnpm tsx dev/scripts/generateEcdsaKeys.ts

   # Generate notification webhook secret
   pnpm generate:notification-secret
   ```

3. **Initialize the database:**

   ```bash
   pnpm migrate:deploy
   ```

4. **Start the backend:**

   ```bash
   pnpm dev
   ```

5. **Verify setup:**

   ```bash
   curl http://localhost:4000/healthcheck
   ```

## Fresh Checkouts and Worktrees

New checkouts and git worktrees need two extra steps before anything typechecks:

1. **Generate protobuf code** - the generated files under `src/gen` are not checked in:

   ```bash
   pnpm buf:generate
   ```

2. **Copy `.env` from an existing checkout** - generated keys and secrets are per-machine, not per-worktree.

## Environment Variables

```bash
# Database
DATABASE_URL="postgresql://postgres:convos@localhost:5432/convos"

# Push Notifications
NOTIFICATION_SERVER_URL=http://localhost:8080
XMTP_NOTIFICATION_SECRET=<generated>

# JWT Authentication (ECDSA P-256)
JWT_PRIVATE_KEY=<generated>
JWT_PUBLIC_KEY=<generated>

# Firebase App Check
FIREBASE_SERVICE_ACCOUNT=<your_firebase_service_account_json>

# Server
NODE_ENV=development
PORT=4000
```

## Docker Services

The `dev/compose.yml` runs:

| Service               | Port       | Description                        |
| --------------------- | ---------- | ---------------------------------- |
| `convos_db`           | 5432       | PostgreSQL for backend             |
| `node`                | 5555, 5556 | XMTP node                          |
| `notification_server` | 8080       | XMTP push notification server      |
| `notification_db`     | -          | PostgreSQL for notification server |

The backend connects to `convos_db` and `notification_server`. It does not connect directly to the XMTP node.

## Database Migrations

The shared local/dev database is schema-pushed and has no `_prisma_migrations` table, so `prisma migrate dev` and `prisma migrate deploy` cannot run against it. Apply new migrations there by running the migration SQL directly with `psql`. Real environments replay the same migration files via `prisma migrate deploy`; if an environment received the SQL manually, reconcile the bookkeeping with `prisma migrate resolve --applied <migration>`.

## Testing Notes

Do not `vi.spyOn` Prisma delegate methods (e.g. `prisma.<model>.findMany`) - spying corrupts the client for every later query in the file, even after `mockRestore()`. Patch the method manually and restore the original afterwards; see the commented pattern in `tests/abilities.test.ts`.

## Authentication Model

The API uses two authentication methods:

| Middleware               | Description                                   |
| ------------------------ | --------------------------------------------- |
| `appCheckOnlyMiddleware` | Firebase App Check (app attestation)          |
| `authMiddleware`         | JWT with ES256 signature, rejects NSE tokens  |
| `authMiddlewareAllowNSE` | JWT that allows NSE tokens (diagnostics only) |

### Endpoint Authentication

| Endpoint            | Auth Method       | Notes                        |
| ------------------- | ----------------- | ---------------------------- |
| `/v2/device`        | AppCheck          | Device registration          |
| `/v2/auth/token`    | AppCheck          | JWT token exchange           |
| `/v2/attachments`   | JWT               | Presigned URLs for uploads   |
| `/v2/notifications` | JWT               | Push notification management |
| `/v2/auth-check`    | JWT (NSE allowed) | Diagnostic endpoint          |

### NSE Tokens

Notification Service Extension (NSE) tokens are issued with `notificationExtensionOnly: true` metadata and 12h expiry. They are used by iOS NSE to authenticate with the Payer Gateway when connecting to the XMTP d14n network. NSE tokens are restricted to the `/v2/auth-check` endpoint only.

## Health Check

Basic health check (returns `OK`):

```bash
curl http://localhost:4000/healthcheck
```

Detailed health check with service status:

```bash
curl http://localhost:4000/healthcheck/details
```

```json
{
  "status": "OK",
  "services": {
    "database": { "status": "healthy" },
    "notifications": { "status": "healthy" }
  }
}
```

## Additional Resources

- [XMTP Push Notifications Guide](https://docs.xmtp.org/inboxes/push-notifs/pn-server)
- [Docker Networking Guide](https://docs.docker.com/network/)
