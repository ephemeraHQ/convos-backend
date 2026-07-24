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

## Driving the iOS app against this backend

The app cannot reach the assistant control plane directly (that route holds the
shared assistant key), so agent features route app -> here -> assistants worker.
To exercise that whole chain locally:

1. `./dev/up` for Postgres, then `pnpm exec prisma migrate deploy`.
2. Start the assistants worker and point `ASSISTANT_API_URL` at it
   (`http://localhost:8787`, the default here); set `ASSISTANT_API_KEY` to that
   worker's `CONVOS_API_KEY`. The worker lives in the `convos-assistants` repo
   (`pnpm dev` in `workers/assistant/`) — nothing here starts it for you.
3. Expose this backend over HTTPS — `ngrok http 4000`. The app will not talk to
   plain HTTP, and a deployed backend cannot reach a worker on your laptop, so
   the tunnel has to front the local backend rather than the other way round.
4. In the app repo, set `CONVOS_API_BASE_URL=https://<tunnel-host>/api` and
   rebuild. Its build phase regenerates `Secrets.swift`, so a `.env` edit alone
   changes nothing until you build.

Four settings here fail somewhere other than where they are set, so they are
worth knowing in advance:

- **SIWE domain mismatch.** See the note on `SIWE_DOMAIN` in `.env.example`.
  Local app builds sign `dev.convos.org`.
- **App Check.** An empty `FIREBASE_SERVICE_ACCOUNT` does not disable it; see
  that variable's note for the runtime-config switch.
- **A cached JWT.** The app holds a token minted by whichever backend it last
  talked to. This one signs with different keys, so authenticated calls 401 and
  the app does not re-authenticate, because the token has not expired.
  Reinstalling clears it, and forces the SIWE handshake you want to watch.
- **Process lifecycle.** `pkill -f "tsx watch"` kills the watcher but leaves the
  node child holding port 4000, so a restarted backend can keep serving the
  previous environment. Confirm with `lsof -nP -iTCP:4000 -sTCP:LISTEN` before
  drawing conclusions about a config change.

A fresh database also means a zero credit balance, which the app surfaces as the
agent having "lost power". Grant through the ledger (never write the credit
tables directly — see `src/payments/AGENTS.md`):

```ts
import { grant } from "@/payments";

// Your account id — copy it from the app (Settings) or query the local DB.
const accountId = "<your-account-id>";

await grant({
  accountId,
  credits: 1_000_000,
  idempotencyKey: `local-${accountId}`,
  kind: "manual",
});
```

`pnpm typecheck` fails on a fresh clone until the generated code exists. Run
`pnpm exec prisma generate` and `pnpm buf:generate` before believing any type
error you did not write.

## Additional Resources

- [XMTP Push Notifications Guide](https://docs.xmtp.org/inboxes/push-notifs/pn-server)
- [Docker Networking Guide](https://docs.docker.com/network/)
