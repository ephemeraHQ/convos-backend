# Local Development Setup

## Prerequisites

- [Bun](https://bun.sh/) runtime
- [Docker](https://www.docker.com/) for running dependencies

## Quick Start

1. **Start Docker services** (PostgreSQL, XMTP node, notification server):

   ```bash
   cd dev && ./up
   ```

2. **Configure environment** - copy `.env.example` to `.env` and generate keys:

   ```bash
   # Generate JWT ECDSA key pair
   bun run dev/scripts/generateEcdsaKeys.ts

   # Generate notification webhook secret
   bun run dev/scripts/generateNotificationSecret.ts
   ```

3. **Start the backend:**

   ```bash
   bun run dev
   ```

4. **Verify setup:**

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

| Service | Port | Description |
|---------|------|-------------|
| `convos_db` | 5432 | PostgreSQL for backend |
| `node` | 5555, 5556 | XMTP node |
| `notification_server` | 8080 | XMTP push notification server |
| `notification_db` | - | PostgreSQL for notification server |

The backend connects to `convos_db` and `notification_server`. It does not connect directly to the XMTP node.

## Health Check

```bash
curl http://localhost:4000/healthcheck
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

