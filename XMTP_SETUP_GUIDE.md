# XMTP Local Development Setup Guide

This guide helps you ensure your backend connects properly to the local XMTP node and validates the connection through health checks.

## Environment Configuration

Create or update your `.env` file with these settings:

```bash
# XMTP Configuration
XMTP_ENV=local
XMTP_DB_ENCRYPTION_BASE_64_KEY=your_base64_encoded_key_here

# Database
DATABASE_URL="postgresql://postgres:convos@localhost:5432/convos"

# Notifications
NOTIFICATION_SERVER_URL=http://localhost:8080
XMTP_NOTIFICATION_SECRET=your_notification_secret_here
TEST_NOTIFICATION_DELIVERY_URL=http://host.docker.internal:4000/api/v1/notifications/xmtp/handle-notification

# Other required vars
JWT_SECRET=your_jwt_secret_here
FIREBASE_SERVICE_ACCOUNT=your_firebase_service_account_json_here
NODE_ENV=development
ENV=local
PORT=4000
```

## Custom XMTP Server Address

If your backend can't reach the XMTP node via `localhost` (common in Docker setups), you can specify a custom server address:

### Option 1: Host Network (Recommended)

Run your backend on the host machine:

```bash
# In your .env file
XMTP_ENV=local
# XMTP_CUSTOM_HOST not needed - will use localhost by default

# Start Docker services
cd dev && ./up

# Start backend on host
bun run dev
```

### Option 2: Custom Host

If you need to specify a different XMTP server address:

```bash
# In your .env file
XMTP_ENV=local
XMTP_CUSTOM_HOST=your-xmtp-node # it will be called in http and in port 5556
```

## Docker Network Setup

The XMTP node runs in Docker and exposes these ports to your host:

- Port 5555: XMTP gRPC API
- Port 5556: XMTP Node API

Your backend connects to the XMTP node using:

- Default: `localhost` (when `XMTP_ENV=local`)
- Custom: Whatever you set in `XMTP_CUSTOM_HOST`

## Starting the Services

1. **Start Docker services:**

   ```bash
   cd dev && ./up
   ```

2. **Start your backend:**
   ```bash
   bun run dev
   ```

## Health Check Validation

The enhanced health check at `/healthcheck` now validates:

- **Database**: Tests PostgreSQL connectivity
- **XMTP**: Tests connection to XMTP node (shows custom host if used)
- **Notifications**: Tests notification server setup (if configured)

### Health Check Response Example

```json
{
  "status": "OK",
  "services": {
    "database": { "status": "healthy" },
    "xmtp": {
      "status": "healthy",
      "environment": "local",
      "inboxId": "0x...",
      "customHost": "custom-host"
    },
    "notifications": { "status": "healthy" }
  }
}
```

## Troubleshooting

### 1. XMTP Connection Issues

**Problem**: Health check shows XMTP as unhealthy

**Solutions**:

- Ensure Docker services are running: `docker ps`
- Check XMTP node logs: `docker logs dev-node-1`
- Verify ports are accessible: `nc -zv localhost 5555`
- Try setting `XMTP_CUSTOM_HOST=localhost` explicitly

**Docker Network Issues**:
If your backend runs in Docker and can't reach `localhost:5555`:

```bash
# Set custom host to use Docker service name
XMTP_CUSTOM_HOST=10.0.0.1
```

### 2. Environment Variables

**Generate missing keys**:

```bash
# Generate XMTP DB encryption key
cd dev/scripts && bun generateDbKey.ts

# Generate notification secret
cd dev/scripts && bun generateNotificationSecret.ts
```

## Testing Connection

### Manual XMTP Test

```bash
# Test if XMTP ports are accessible
nc -zv localhost 5555
nc -zv localhost 5556
```

### Backend Health Check

```bash
# Test your backend health check
curl http://localhost:4000/healthcheck

# Should return JSON with all services healthy and show your XMTP config
```

## Common Docker Networking Solutions

### If backend can't reach XMTP node:

1. **Use host networking**: Run backend on host, Docker services in containers
2. **Set custom host**: Use `XMTP_CUSTOM_HOST=custom_host_or_ip`
3. **Check Docker networks**: Ensure containers are on the same network and that devices on the same network can talk to each other

### Example for different setups:

```bash
# Backend on host, XMTP in Docker
XMTP_ENV=local
XMTP_CUSTOM_HOST=10.0.0.1 (local network IP)

# Backend on Docker, XMTP in Docker (default)
XMTP_ENV=local
# No XMTP_CUSTOM_HOST needed for simulators (same local machine)
```

## Additional Resources

- [XMTP Node Documentation](https://docs.xmtp.org/network/run-node)
- [XMTP Push Notifications Guide](https://docs.xmtp.org/inboxes/push-notifs/pn-server)
- [Docker Networking Guide](https://docs.docker.com/network/)
