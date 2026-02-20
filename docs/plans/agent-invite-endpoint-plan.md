# Agent Join via Invite Endpoint - Technical Plan

## Context

When a Convos iOS user creates a group conversation, they should be able to invite an AI agent to join. Today, agents can only be launched from the convos-agents pool manager dashboard. This plan adds a new endpoint to `convos-backend` so the iOS app can trigger an agent to join a conversation using an invite slug — ensuring only genuine Convos app instances (verified via JWT auth) can make this request.

The convos-agents pool already supports joining existing conversations via `POST /api/pool/claim` with a `joinUrl` parameter. The backend just needs to bridge the gap: authenticate the iOS request, construct the invite URL from the slug, and forward to the pool.

---

## Architecture Overview

```
iOS App                    convos-backend                 convos-agents pool
  │                             │                               │
  │  POST /api/v2/agents/join   │                               │
  │  (JWT + invite slug)        │                               │
  │ ──────────────────────────> │                               │
  │                             │  POST /api/pool/claim         │
  │                             │  (Bearer AGENT_POOL_API_KEY)  │
  │                             │  { joinUrl, agentName, ... }  │
  │                             │ ────────────────────────────> │
  │                             │                               │ claims idle instance
  │                             │                               │ provisions with joinUrl
  │                             │         { joined, ... }       │
  │                             │ <──────────────────────────── │
  │      { success, joined }    │                               │
  │ <────────────────────────── │                               │
```

---

## Changes to convos-backend

### 1. New env vars in `src/config.ts`

Add two optional env vars (optional so existing deployments don't break):

| Variable             | Description                                    | Example                                     |
| -------------------- | ---------------------------------------------- | ------------------------------------------- |
| `AGENT_POOL_URL`     | Base URL of the convos-agents pool manager     | `https://convos-agents-pool.up.railway.app` |
| `AGENT_POOL_API_KEY` | Shared secret for authenticating with the pool | `sk-pool-...`                               |

These are **not** validated at startup (unlike `XMTP_NOTIFICATION_SECRET`). The endpoint itself returns 503 if they're missing.

### 2. New route: `src/api/v2/agents/agents.router.ts`

```
POST /api/v2/agents/join
```

- Protected by `authMiddleware` (JWT from iOS app — same auth as notifications, assets, etc.)
- Request body: `{ slug: string, instructions?: string }`
- Constructs the full invite URL from the slug (using the correct domain based on `XMTP_ENV`)
- Calls `POST <AGENT_POOL_URL>/api/pool/claim` with:
  - `joinUrl` — the full invite URL
  - `agentName` — `"convos-agent"`
  - `instructions` — from client if provided, otherwise defaults to `"You are a helpful assistant."`
- Returns result to iOS client

### 3. New handler: `src/api/v2/agents/handlers/join.ts`

Request validation (zod):

```typescript
{
  slug: z.string().min(1).max(2048),
  instructions: z.string().optional(),
}
```

Response shape:

```typescript
// Success
{ success: true, joined: boolean }

// Error
{ success: false, error: string, message: string }
```

Invite URL construction based on `XMTP_ENV`:

- `production` → `https://popup.convos.org/v2?i=<slug>`
- anything else → `https://dev.convos.org/v2?i=<slug>`

### 4. Register the route in `src/api/v2/index.ts`

```typescript
import { agentJoinLimiter } from "@/middleware/rateLimit";
import { agentsRouter } from "./agents/agents.router";

// ...
v2Router.use("/agents", agentJoinLimiter, authMiddleware, agentsRouter);
```

### Files to create/modify

| File                                 | Action                                                |
| ------------------------------------ | ----------------------------------------------------- |
| `src/config.ts`                      | Add `AGENT_POOL_URL` and `AGENT_POOL_API_KEY` exports |
| `src/api/v2/agents/agents.router.ts` | **Create** — router with `POST /join`                 |
| `src/api/v2/agents/handlers/join.ts` | **Create** — handler logic                            |
| `src/api/v2/index.ts`                | Add agents router mount                               |

### Error handling

| Scenario                   | HTTP Status | Error Code               |
| -------------------------- | ----------- | ------------------------ |
| Missing slug               | 400         | `INVALID_REQUEST`        |
| Agent pool not configured  | 503         | `AGENT_POOL_UNAVAILABLE` |
| No idle instances in pool  | 503         | `NO_AGENTS_AVAILABLE`    |
| Pool claim failed          | 502         | `AGENT_PROVISION_FAILED` |
| Pool request timeout (30s) | 504         | `AGENT_POOL_TIMEOUT`     |

---

## Changes to convos-agents

No changes needed for the initial implementation. The pool manager's `POST /api/pool/claim` already accepts `joinUrl` and handles the full join flow. The `POOL_API_KEY` is already the auth mechanism.

If later you want a dedicated lightweight endpoint (e.g., `POST /api/pool/join` that only requires `joinUrl` and uses sensible defaults), that would be a follow-up.

---

## Environment / Deployment

Both services need to share the `AGENT_POOL_API_KEY` secret:

- `convos-backend` uses it as an outbound auth token
- `convos-agents` already has it as `POOL_API_KEY`

Set `AGENT_POOL_API_KEY` in convos-backend's deployment to the same value as `POOL_API_KEY` in convos-agents.

Add to convos-backend deployment env:

```
AGENT_POOL_URL=<pool manager URL>
AGENT_POOL_API_KEY=<same as POOL_API_KEY in convos-agents>
```

---

## Future Considerations (not in this PR)

These are things worth noting but **not part of this initial implementation**:

1. **Request status monitoring** — An endpoint to check if the agent has successfully joined (the pool claim is synchronous and waits up to 60s, so the initial response already tells you)
2. **Queuing** — If pool has no idle instances, queue the request and fulfill when one becomes available (currently returns 503)
3. **Custom agent instructions** — The iOS client can already pass `instructions` to customize the agent (trip planner, translator, etc.)
4. **Per-device rate limiting** — More granular rate limiting keyed by device ID (currently uses IP-based rate limiting)
5. **Agent name from conversation** — Extract the conversation name from the invite slug to use as agent name

---

## Verification

1. **Unit**: Ensure zod validation rejects invalid slugs, missing fields
2. **Integration**: Mock the pool manager HTTP call, verify correct URL construction per environment
3. **Manual E2E**:
   - Deploy to staging
   - Create a conversation in the iOS app
   - Generate an invite
   - Call `POST /api/v2/agents/join` with the invite slug and a valid JWT
   - Verify an agent joins the conversation in the iOS app
4. **Error paths**: Test with pool down, no idle instances, invalid slug
