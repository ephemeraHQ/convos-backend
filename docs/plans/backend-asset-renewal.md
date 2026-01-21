# Backend: Asset Renewal Endpoint

> **Status**: Draft
> **Author**: @lourou
> **Created**: 2026-01-21
> **Updated**: 2026-01-21

## Overview

Implement a batch asset renewal endpoint (`POST /v2/assets/renew-batch`) that allows iOS clients to extend the S3 lifecycle of assets (profile/group images) by performing a server-side "copy-to-self" operation. This resets the object's `LastModified` timestamp, effectively extending the 30-day lifecycle by another 30 days from the renewal time.

This endpoint is part of the broader asset lifecycle management system documented in `docs/plans/asset-uploads.md`.

## Problem Statement

Profile and group images need to persist indefinitely as long as users actively use the app, while chat images should naturally expire after 30 days. With a single S3 lifecycle rule that expires all objects after 30 days of inactivity, we need a mechanism for clients to periodically "renew" important assets by resetting their `LastModified` date.

The S3 copy-to-self operation is the standard pattern for this, but it requires server-side execution since clients cannot directly invoke S3 CopyObject operations on objects they've already uploaded.

## Goals

- Provide a batch endpoint that renews multiple assets in a single request
- Process renewals in parallel for performance
- Return granular per-asset results (success/failure) without failing the entire batch
- Implement proper rate limiting to prevent abuse
- Support up to 100 URLs per batch request
- Allow any authenticated user to renew any asset (intentional - no per-asset authorization)
- Handle edge cases gracefully (404s, invalid URLs, S3 errors)

## Non-Goals

- Per-asset authorization (users renewing "their own" assets only)
- Tracking who renewed which asset
- Automatic renewal scheduling (client responsibility)
- Asset metadata modification beyond resetting `LastModified`
- Migration of existing assets
- Support for non-CDN URL formats

## User Stories

### As an iOS developer, I want to batch-renew assets on app launch

Acceptance criteria:

- I can POST to `/v2/assets/renew-batch` with an array of up to 100 asset URLs
- I receive a response with counts of renewed/failed assets plus per-URL details
- The endpoint processes all URLs even if some fail
- Failed renewals include error codes (`not_found`, `invalid_url`, `internal_error`)
- The request completes within reasonable time (<5s for 100 assets)

### As a backend developer, I want to prevent renewal endpoint abuse

Acceptance criteria:

- Rate limiting is enforced per device (10 batch requests per hour)
- Batch size is capped at 100 URLs per request
- Authentication is required (JWT via `authMiddleware`)
- Invalid requests return appropriate 400/401 status codes

### As an inactive user returning after 30+ days, I want seamless recovery

Acceptance criteria:

- When renewal fails with `not_found`, the iOS client can detect this
- The iOS client has the logic to re-upload from local cache
- The backend doesn't need to track or special-case expired assets

## Technical Design

### Architecture

```
Client Request Flow:
┌────────────────────────────────────────────────────────────┐
│ iOS: POST /v2/assets/renew-batch                           │
│   Headers: X-Convos-AuthToken: <jwt>                       │
│   Body: { assetUrls: ["https://assets.convos.xyz/a.bin"] } │
│     ↓                                                       │
│ Backend: authMiddleware validates JWT                      │
│     ↓                                                       │
│ Backend: assetRenewalLimiter (10 req/hr per user)          │
│     ↓                                                       │
│ Backend: Validate request body (Zod)                       │
│     ↓                                                       │
│ Backend: Extract S3 keys from CDN URLs                     │
│     ↓                                                       │
│ Backend: Promise.all → S3 CopyObjectCommand (parallel)     │
│     ↓                                                       │
│ S3: Copy each object to itself (resets LastModified)       │
│     ↓                                                       │
│ Backend: Aggregate results (renewed, failed, per-URL)      │
│     ↓                                                       │
│ Client: Process response, handle 404s → re-upload          │
└────────────────────────────────────────────────────────────┘
```

### API Specification

#### Request

```
POST /v2/assets/renew-batch
Content-Type: application/json
X-Convos-AuthToken: <jwt>

{
  "assetUrls": [
    "https://assets.convos.xyz/abc123.bin",
    "https://assets.convos.xyz/def456.png",
    "https://assets.convos.xyz/ghi789.jpg"
  ]
}
```

**Validation:**
- `assetUrls`: Required, array of strings, 1-100 URLs
- Each URL must be a valid URL string
- URLs should match CDN base URL from `CDN_BASE_URL` env var (though not strictly enforced)

#### Success Response (200 OK)

```json
{
  "renewed": 2,
  "failed": 1,
  "results": [
    {
      "url": "https://assets.convos.xyz/abc123.bin",
      "success": true
    },
    {
      "url": "https://assets.convos.xyz/def456.png",
      "success": true
    },
    {
      "url": "https://assets.convos.xyz/ghi789.jpg",
      "success": false,
      "error": "not_found"
    }
  ]
}
```

**Error Types:**
- `not_found` - S3 object doesn't exist (expired or never uploaded)
- `invalid_url` - Cannot extract object key from URL
- `internal_error` - Unexpected S3 error

#### Error Responses

**400 Bad Request** - Invalid request body
```json
{
  "error": "assetUrls must be a non-empty array"
}
```

**400 Bad Request** - Batch size exceeded
```json
{
  "error": "Maximum 100 URLs per request"
}
```

**401 Unauthorized** - Missing or invalid JWT
```json
{
  "error": "Invalid auth token"
}
```

**429 Too Many Requests** - Rate limit exceeded
```json
{
  "error": "Too many renewal requests, please try again later"
}
```

**503 Service Unavailable** - S3 not configured
```json
{
  "error": "Asset renewal not available - S3 not configured"
}
```

### Data Flow

**S3 Copy-to-Self Operation:**
```typescript
// This is the core operation that resets LastModified
await s3Client.send(new CopyObjectCommand({
  Bucket: bucket,
  CopySource: `${bucket}/${objectKey}`,
  Key: objectKey,
  MetadataDirective: "COPY"  // Preserve existing metadata
}));
```

**Before renewal:**
```
Object: abc123.bin
LastModified: 2026-01-01T00:00:00Z
→ Will expire: 2026-01-31T00:00:00Z (30 days later)
```

**After renewal (on 2026-01-15):**
```
Object: abc123.bin
LastModified: 2026-01-15T00:00:00Z  ← Reset!
→ Will expire: 2026-02-14T00:00:00Z (30 days from renewal)
```

### Implementation Details

#### File Structure

```
src/api/v2/assets/
├── assets.router.ts              # Router setup (new)
└── handlers/
    └── renew-batch.ts            # Renewal handler (new)

src/middleware/
└── rateLimit.ts                  # Add assetRenewalLimiter (modify)

src/api/v2/
└── index.ts                      # Register assets router (modify)
```

#### Key Functions

**URL Parsing:**
```typescript
function extractKeyFromUrl(url: string, cdnBaseUrl?: string): string | null {
  try {
    const parsed = new URL(url);
    // Remove leading slash from pathname
    const key = parsed.pathname.replace(/^\//, "");
    return key.length > 0 ? key : null;
  } catch {
    return null;
  }
}
```

**Batch Processing:**
```typescript
const results = await Promise.all(
  assetUrls.map(async (url): Promise<RenewResult> => {
    const key = extractKeyFromUrl(url, env.CDN_BASE_URL);
    if (!key) {
      return { url, success: false, error: "invalid_url" };
    }

    try {
      await s3Client.send(new CopyObjectCommand({
        Bucket: env.PUBLIC_ASSETS_BUCKET,
        CopySource: `${env.PUBLIC_ASSETS_BUCKET}/${key}`,
        Key: key,
        MetadataDirective: "COPY"
      }));

      return { url, success: true };
    } catch (error: any) {
      if (error.name === "NoSuchKey" || error.name === "NotFound") {
        return { url, success: false, error: "not_found" };
      }
      req.log.error({ error, url, key }, "Unexpected S3 error during renewal");
      return { url, success: false, error: "internal_error" };
    }
  })
);
```

### Environment Variables

Reuses existing variables from attachment uploads:

- `PUBLIC_ASSETS_BUCKET` - S3 bucket name
- `AWS_REGION` - AWS region (optional, defaults to SDK config)
- `CDN_BASE_URL` - CDN base URL for URL validation (optional)

### Security Considerations

#### Authentication

- **Required**: JWT token via `authMiddleware`
- **Extracted**: `res.locals.deviceId` available for logging
- **Rejected**: NSE (Notification Service Extension) tokens not allowed

#### Authorization Model

**Intentionally permissive** - any authenticated user can renew any asset:

**Rationale:**
1. Users renew their own profile images
2. Users renew group images for groups they're in
3. Client is trusted to only send relevant URLs
4. Worst case: unnecessary renewal (no data access, just S3 ops)
5. No privacy risk - URL alone reveals no information about content

**What this means:**
- No check for "does this user own this asset"
- No check for "is this user in this group"
- Client-side logic determines which URLs to send
- Backend blindly processes all URLs in batch

#### Rate Limiting

**New rate limiter** in `src/middleware/rateLimit.ts`:

```typescript
export const assetRenewalLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,  // 1 hour
  limit: 10,  // 10 batch requests per hour
  keyGenerator: (req, res) => res.locals.deviceId || req.ip,
  legacyHeaders: false,
  standardHeaders: "draft-8",
  message: "Too many renewal requests, please try again later"
});
```

**Reasoning:**
- 10 batches/hour per device = 1000 potential assets/hour per device
- Active device triggers renewal every ~15 days (once every ~360 hours)
- 10/hour is comfortable buffer for legitimate use
- Prevents abuse while allowing generous headroom
- Falls back to IP if deviceId unavailable (edge case)

#### Input Validation

- Max batch size: 100 URLs (prevents DoS)
- URL format validation (basic URL parsing)
- S3 client timeout: 30s per operation (SDK default)
- Overall request timeout: 30s (Express default)

### Error Handling

**Graceful degradation:**
- Individual asset failures don't fail the batch
- All errors logged with context (URL, key, error type)
- Per-URL error codes help client take appropriate action

**Error classification:**
- `NoSuchKey` / `NotFound` → `not_found` (client can re-upload)
- Invalid URL → `invalid_url` (client bug or URL corruption)
- Other S3 errors → `internal_error` (retry or investigate)

### Logging

**Structured logging with pino:**

```typescript
req.log.info(
  {
    deviceId: res.locals.deviceId,
    urlCount: assetUrls.length,
    renewed,
    failed
  },
  "Asset batch renewal completed"
);

req.log.error(
  {
    error,
    url,
    key,
    errorName: error.name
  },
  "S3 renewal operation failed"
);
```

**Log on:**
- Batch request received (info)
- Batch completed with summary (info)
- Individual S3 errors (error)
- Rate limit exceeded (warn - handled by rate limiter)

## Implementation Plan

### Phase 1: Core Endpoint

**Files to create:**

1. **`src/api/v2/assets/assets.router.ts`**
   - Import Express Router
   - Import `renewBatchHandler`
   - Create router with POST `/renew-batch` route

2. **`src/api/v2/assets/handlers/renew-batch.ts`**
   - Import S3Client, CopyObjectCommand
   - Define Zod schemas for request validation
   - Implement `extractKeyFromUrl()` helper
   - Implement batch processing with Promise.all
   - Export `renewBatchHandler`

**Files to modify:**

3. **`src/api/v2/index.ts`**
   - Import `assetsRouter`
   - Add route: `v2Router.use("/assets", authMiddleware, assetRenewalLimiter, assetsRouter)`

4. **`src/middleware/rateLimit.ts`**
   - Add `assetRenewalLimiter` export (10 req/hr per device)

**Tasks:**
- [ ] Create assets router module
- [ ] Implement renew-batch handler with Zod validation
- [ ] Add S3 CopyObjectCommand integration
- [ ] Implement URL-to-key extraction logic
- [ ] Add rate limiter middleware
- [ ] Wire up routes in v2 index
- [ ] Add structured logging

### Phase 2: Testing

**Unit Tests:**
- [ ] URL parsing (valid CDN URLs, S3 URLs, invalid URLs)
- [ ] Batch size validation (0, 1, 100, 101 URLs)
- [ ] Error classification (NoSuchKey → not_found)
- [ ] Result aggregation (mix of success/failure)

**Integration Tests:**
- [ ] End-to-end with real S3 (test bucket)
- [ ] Verify `LastModified` actually changes
- [ ] Verify lifecycle respects new timestamp
- [ ] Test parallel processing (100 URLs)
- [ ] Test rate limiting enforcement

**Manual Testing:**
- [ ] Upload test asset via presigned URL
- [ ] Note `LastModified` timestamp
- [ ] Call renewal endpoint
- [ ] Verify `LastModified` updated
- [ ] Wait for expiration (use 1-day lifecycle test bucket)
- [ ] Verify renewed objects survive past original expiration

### Phase 3: Documentation & Deployment

- [ ] Update API documentation
- [ ] Add endpoint to Postman collection
- [ ] Add monitoring/alerting for renewal failures
- [ ] Deploy to staging environment
- [ ] Validate with iOS app in staging
- [ ] Deploy to production
- [ ] Monitor renewal traffic patterns

## Testing Strategy

### Unit Tests

**File:** `src/api/v2/assets/handlers/renew-batch.test.ts`

```typescript
describe('extractKeyFromUrl', () => {
  it('should extract key from CDN URL', () => {
    expect(extractKeyFromUrl('https://assets.convos.xyz/abc123.bin'))
      .toBe('abc123.bin');
  });

  it('should return null for invalid URL', () => {
    expect(extractKeyFromUrl('not-a-url')).toBe(null);
  });

  it('should handle URLs with path segments', () => {
    expect(extractKeyFromUrl('https://cdn.example.com/path/to/file.bin'))
      .toBe('path/to/file.bin');
  });
});

describe('POST /v2/assets/renew-batch', () => {
  it('should require authentication', async () => {
    const res = await request(app)
      .post('/api/v2/assets/renew-batch')
      .send({ assetUrls: ['https://assets.convos.xyz/test.bin'] });

    expect(res.status).toBe(401);
  });

  it('should reject batch size > 100', async () => {
    const urls = Array(101).fill('https://assets.convos.xyz/test.bin');
    const res = await authenticatedRequest()
      .post('/api/v2/assets/renew-batch')
      .send({ assetUrls: urls });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Maximum 100');
  });

  it('should handle mixed success/failure', async () => {
    // Mock S3: first succeeds, second returns NoSuchKey
    const res = await authenticatedRequest()
      .post('/api/v2/assets/renew-batch')
      .send({
        assetUrls: [
          'https://assets.convos.xyz/exists.bin',
          'https://assets.convos.xyz/missing.bin'
        ]
      });

    expect(res.status).toBe(200);
    expect(res.body.renewed).toBe(1);
    expect(res.body.failed).toBe(1);
    expect(res.body.results[0].success).toBe(true);
    expect(res.body.results[1].success).toBe(false);
    expect(res.body.results[1].error).toBe('not_found');
  });
});
```

### Integration Tests

**Accelerated lifecycle validation:**

1. Create test bucket with 1-day lifecycle
2. Upload test object
3. Record `LastModified` timestamp (T0)
4. Wait 12 hours
5. Call renewal endpoint
6. Verify `LastModified` updated (T1 = T0 + 12h)
7. Wait 24 hours from T0 (original expiration)
8. Verify object still exists (renewed object survives)
9. Wait 24 hours from T1
10. Verify object expired (at T1 + 24h)

### Performance Testing

- Batch of 100 URLs should complete in <5 seconds
- S3 CopyObject is fast (server-side, no data transfer)
- Parallel processing with Promise.all critical for performance

### Manual Testing Scenarios

1. **Happy path:**
   - Upload profile image → get CDN URL
   - Renew via batch endpoint
   - Verify 200 response, renewed: 1, failed: 0

2. **404 handling:**
   - Request renewal for non-existent URL
   - Verify response includes `not_found` error
   - Client should re-upload from cache

3. **Invalid URL:**
   - Send malformed URL
   - Verify `invalid_url` error returned

4. **Rate limiting:**
   - Send 11 batch requests in 1 hour
   - Verify 11th returns 429

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| S3 costs from abuse | Medium | Rate limiting (10 req/hr = max 1000 assets/hr per device) |
| Renewal endpoint overload | Medium | Rate limiting + batch size cap (100 URLs) |
| Client sends wrong URLs | Low | Worst case: unnecessary renewal (no data leak) |
| S3 copy fails silently | Medium | Structured logging + per-URL error reporting |
| URL format changes | Low | Flexible URL parsing (pathname extraction) |
| Expired assets not detected | Low | Clear `not_found` error code for client handling |
| NSE tokens accessing endpoint | Medium | `authMiddleware` rejects NSE tokens by default |

## Open Questions

- [x] Should we validate that URLs belong to the requesting user? **No** - intentionally permissive
- [x] Should we support non-CDN S3 URLs? **Yes** - flexible URL parsing
- [x] What rate limit is appropriate? **10 batch requests per hour per device**
- [x] Should we batch responses (partial success)? **Yes** - all-or-nothing would be poor UX
- [ ] Should we add metrics (renewed count, failed count) to monitoring? **Recommended for Phase 3**
- [ ] Should we add a dry-run mode for testing? **Optional - could be useful**

## Performance Considerations

### S3 Copy Performance

- **Server-side operation**: No data transfer over network
- **Speed**: ~100-200ms per object (AWS internal copy)
- **Parallel processing**: 100 concurrent copies = ~1-2 seconds total
- **Cost**: Minimal (no egress, just S3 API calls)

### Endpoint Performance

- Request size: ~5KB for 100 URLs (50 bytes per URL avg)
- Response size: ~10KB (includes per-URL results)
- Total latency target: <5s for 100 URLs
- Memory: Minimal (streaming JSON, no buffering)

### Scalability

- **Per-device limit**: 10 batches/hour = max 1000 assets/hour
- **Expected load**: 1 batch per device per 15 days = ~0.003 req/hour per active device
- **With 10k active devices**: ~30 req/hour server-wide (very low)
- **Database impact**: None (stateless endpoint)

## References

- Parent PRD: [`docs/plans/asset-uploads.md`](./asset-uploads.md)
- S3 CopyObject: https://docs.aws.amazon.com/AmazonS3/latest/API/API_CopyObject.html
- S3 Lifecycle: https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lifecycle-mgmt.html
- Express Rate Limit: https://www.npmjs.com/package/express-rate-limit
- iOS Implementation: See Appendix A in `docs/plans/asset-uploads.md`
