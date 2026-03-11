# Agent Asset Upload — Auth & S3 Endpoint

**Status:** Draft
**Linear:** [AGNT-41](https://linear.app/convos/issue/AGNT-41/add-agent-asset-upload-auth-and-s3-endpoint)
**Assignee:** @louis

## Context

Agents (AI assistants via convos-cli) need to upload files to S3 — starting with profile pictures, but also for general image handling in conversations. The current upload flow (`GET /api/v2/attachments/presigned-url`) requires iOS device auth (AppCheck → JWT), which agents can't use.

### What broke

PR [convos-cli#11](https://github.com/xmtplabs/convos-cli/pull/11) migrated conversation profiles from `appData` (shared protobuf blob) to dedicated `ProfileUpdate` XMTP messages. The old proto had a plain `image` string field (field 3) that accepted raw URLs. The new proto only has `encrypted_image` (field 2, `EncryptedProfileImage`). The CLI's `update-profile --image <url>` command silently discards the image — it reports success but the image is never included in the `ProfileUpdate` message. See [convos-cli#14](https://github.com/xmtplabs/convos-cli/issues/14).

### Decisions from team discussion (2026-03-10)

| Decision           | Outcome                                                                                                              |
| ------------------ | -------------------------------------------------------------------------------------------------------------------- |
| **Bucket**         | Same `PUBLIC_ASSETS_BUCKET`, dedicated route/directory: assistant/\*                                                 |
| **Retention**      | Same 30-day rolling policy (same as user PFPs and group images)                                                      |
| **Auth**           | Dedicated auth mechanism — shared API key between agent pool and backend (like existing `AGENT_POOL_API_KEY`)        |
| **Endpoint**       | New dedicated upload route for agents                                                                                |
| **Encryption**     | Agents should encrypt profile photos same as users (encryption materials are in `appData`, can be replicated in CLI) |
| **Infrastructure** | Keep everything in one AWS account, Terraform-managed                                                                |

---

## Architecture

```
Agent (convos-cli)          convos-backend                    S3
  │                              │                             │
  │  GET /api/v2/agents/assets/presigned-url                   │
  │  (X-Agent-API-Key)           │                             │
  │  ?contentType=image/png      │                             │
  │ ───────────────────────────> │                             │
  │                              │  Generate presigned PUT URL │
  │      { uploadUrl, assetUrl,  │                             │
  │        objectKey }           │                             │
  │ <─────────────────────────── │                             │
  │                                                            │
  │  PUT <uploadUrl>                                           │
  │  (file data)                                               │
  │ ─────────────────────────────────────────────────────────> │
  │        200 OK                                              │
  │ <───────────────────────────────────────────────────────── │
  │                                                            │
  │  [encrypt image, send ProfileUpdate via XMTP               │
  │   or send as message attachment]                           │
```

---

## Implementation

### 1. New env var

```
AGENT_ASSETS_API_KEY=<shared secret>
```

Shared between convos-backend and the agent pool/CLI. Added to `src/config.ts` as optional (endpoint returns 503 if not configured). Managed via Terraform in xmtp-infra.

Separate from `AGENT_POOL_API_KEY` to allow independent rotation.

### 2. New middleware: `agentApiKeyAuth`

Simple API key check — no AppCheck, no JWT, no device registration.

```typescript
// src/middleware/agentAuth.ts
export const agentApiKeyAuth = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const apiKey = req.header("X-Agent-API-Key");
  if (!AGENT_ASSETS_API_KEY || apiKey !== AGENT_ASSETS_API_KEY) {
    res.status(401).json({ error: "Invalid or missing agent API key" });
    return;
  }
  next();
};
```

### 3. New route: `GET /api/v2/agents/assets/presigned-url`

Mirrors the existing `GET /api/v2/attachments/presigned-url` but:

- Uses `agentApiKeyAuth` middleware instead of JWT auth
- Stores files under `agents/` prefix in the same bucket
- Same CDN base URL
- Same presigned URL expiry (1 hour)

```typescript
// Key generation with agents/ prefix
const objectKey = `agents/${uuidv4()}${extension ? `.${extension}` : ""}`;
```

### 4. Wire up in router

```typescript
// src/api/v2/index.ts
v2Router.use("/agents/assets", agentApiKeyAuth, agentAssetsRouter);
```

### 5. Renewal — who renews agent assets?

Agent-uploaded assets follow the same 30-day lifecycle. However, **iOS currently only renews its own PFP and the group image** — it does not renew other members' PFPs or images sent in chat. This means agent profile pictures and any files agents share in messages would expire after 30 days with no one renewing them.

**Decision:** Agents renew their own assets. Two strategies:

1. **On activity** — when an agent becomes active (sends/receives a message), it renews its assets
2. **Scheduled** — agent pool runs a cron job around the 30-day mark, renews assets for agents that have had recent group activity

Agents need access to `POST /api/v2/assets/renew-batch` using the same `AGENT_ASSETS_API_KEY` auth. This endpoint currently uses JWT auth — needs to also accept agent API key auth.

---

## S3 Key Structure

```
PUBLIC_ASSETS_BUCKET/
├── <uuid>.png              ← user uploads (existing)
├── <uuid>.jpg              ← user uploads (existing)
└── agents/
    ├── <uuid>.png          ← agent uploads (new)
    └── <uuid>.jpg          ← agent uploads (new)
```

The `agents/` prefix is purely organizational — same lifecycle rules apply (S3 lifecycle is bucket-wide based on `LastModified`).

---

## Profile Picture Encryption

For agent profile pictures to work with the new `ProfileUpdate` proto, agents need to:

1. Upload the image to S3 (via this new endpoint)
2. Read the encryption key from conversation `appData`
3. Encrypt the image URL using the same scheme as iOS
4. Send a `ProfileUpdate` XMTP message with `encrypted_image`

The encryption materials (key) are already stored in `appData` and implemented on iOS. The convos-cli needs to replicate this encryption. This is a **convos-cli change**, not a backend change.

**TODO (convos-cli):** Implement the `EncryptedProfileImage` encryption path in convos-cli.

---

## Files to Create/Modify

| File                                                     | Change                                                      |
| -------------------------------------------------------- | ----------------------------------------------------------- |
| `src/config.ts`                                          | Add `AGENT_ASSETS_API_KEY` export                           |
| `src/middleware/agentAuth.ts`                            | **New** — API key auth middleware                           |
| `src/api/v2/agents/assets/agent-assets.router.ts`        | **New** — router with presigned URL endpoint                |
| `src/api/v2/agents/assets/handlers/get-presigned-url.ts` | **New** — handler (mirrors existing, adds `agents/` prefix) |
| `src/api/v2/index.ts`                                    | Mount agent assets router                                   |
| `src/api/v2/agents/assets/agent-assets.router.ts`        | Also mount `POST /renew-batch` for agents                   |

---

## Rate Limiting

Use a dedicated rate limiter for agent uploads, separate from user uploads:

```typescript
export const agentAssetLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 50, // 50 requests per minute
  keyGenerator: () => "agent-global", // single pool, not per-IP
});
```

50/min to accommodate general image handling beyond just profile pics.

---

## Security Considerations

- **API key auth is simpler than JWT** — acceptable because agents are trusted server-side processes, not end-user clients
- **Key rotation** — if compromised, rotate the env var and redeploy. No device re-registration needed
- **No AppCheck** — agents can't do device attestation. The API key is the trust boundary
- **S3 prefix isolation** — `agents/` prefix lets us audit/delete agent files independently if needed

---

## Out of Scope

- Image encryption in convos-cli (tracked as TODO in convos-cli)
- Virus/malware scanning
- Image resizing/optimization
- Per-agent identity tracking (all agents share one API key)
- Railway storage buckets (decided to keep on AWS/Terraform)

---

## Open Questions Summary

| #   | Question                                                      | Status                                                                           |
| --- | ------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 1   | ~~Reuse `AGENT_POOL_API_KEY` or new `AGENT_ASSETS_API_KEY`?~~ | ✅ New separate `AGENT_ASSETS_API_KEY`                                           |
| 2   | ~~Rate limit for agent uploads?~~                             | ✅ 50/min                                                                        |
| 3   | ~~Content type restrictions?~~                                | ✅ Any file type — needed in near-term                                           |
| 4   | ~~CLI encryption work tracked?~~                              | ✅ In progress — [convos-cli#15](https://github.com/xmtplabs/convos-cli/pull/15) |
| 5   | ~~Who renews agent PFPs?~~                                    | ✅ Agents renew their own assets (see below)                                     |
