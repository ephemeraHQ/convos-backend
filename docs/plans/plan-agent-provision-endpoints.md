# Plan: Service Provisioning Endpoints

## Routes

```text
POST /api/v2/agents/provision/email    { "instanceId": "<id>" }  →  { "email": "...", "provisioned": true }
POST /api/v2/agents/provision/sms      { "instanceId": "<id>" }  →  { "phone": "+1...", "provisioned": true }
GET  /api/v2/agents/provision/status?instanceId=<id>             →  { "instanceId", "email", "phone" }
```

Auth: `Authorization: Bearer <POOL_API_KEY>`

## Idempotency

Calls are idempotent. The pool returns:

- `provisioned: true` — freshly created
- `provisioned: false` — already existed, returns the existing email/phone

No duplicates are created on repeated calls for the same instance.

## New files

| File                                                      | Purpose                                                                      |
| --------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `src/middleware/poolAuth.ts`                              | Bearer token middleware — constant-time compare against `AGENT_POOL_API_KEY` |
| `src/api/v2/agents/provision/provision.router.ts`         | Router with both provision endpoints                                         |
| `src/api/v2/agents/provision/handlers/provision-email.ts` | Email handler                                                                |
| `src/api/v2/agents/provision/handlers/provision-sms.ts`   | SMS handler                                                                  |

## Modified files

| File                          | Change                                                                                                     |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `src/api/v2/index.ts`         | Mount provision router at `/agents/provision` with `poolAuth` before the JWT-protected `/agents` catch-all |
| `src/middleware/rateLimit.ts` | Add `serviceProvisionLimiter`                                                                              |

## Handler logic (both)

1. Validate body with zod: `{ instanceId: string }`
2. Guard `AGENT_POOL_URL` + `AGENT_POOL_API_KEY` configured (503)
3. Call pool:
   - Email: `POST ${AGENT_POOL_URL}/api/proxy/email/provision` with `{ instanceId }`
   - SMS: `POST ${AGENT_POOL_URL}/api/proxy/sms/provision` with `{ instanceId }`
   - Headers: `Authorization: Bearer ${AGENT_POOL_API_KEY}`, `Content-Type: application/json`
   - 30s timeout via `AbortSignal.timeout`
4. Return pool response (including `provisioned` flag) or map errors

## No new env vars, no DB changes

Reuses `AGENT_POOL_URL` + `AGENT_POOL_API_KEY`.
