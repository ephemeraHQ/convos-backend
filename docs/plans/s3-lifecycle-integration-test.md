# S3 Lifecycle Integration Test Plan

## Overview

Create integration tests to verify the S3 lifecycle policy and copy-to-self renewal mechanism work correctly on the AWS test bucket (24h lifecycle).

**Key constraint**: CI cannot access S3 directly, but can call backend endpoints with a secret token.

**Base branch**: `otr-dev`

## Current State on `otr-dev`

Already implemented:

- `POST /v2/assets/test/lifecycle` endpoint (no auth currently)
- `POST /v2/assets/renew-batch` endpoint for batch renewal
- Unit tests in `/tests/renew-batch.test.ts`
- `LIFECYCLE_TEST_BUCKET` env var for 24h test bucket on AWS S3
- `webhookAuthMiddleware` pattern for secret-based auth

---

## Implementation Plan

### Part 1: CI Integration Test for Renewal (via endpoint)

**Goal**: Verify copy-to-self mechanism works, called from CI via HTTP after every deploy.

**Changes Required**:

1. **Add token-based auth to test endpoint** (`src/middleware/lifecycleTestAuth.ts`)

   - Follow `webhookAuthMiddleware` pattern
   - Use `LIFECYCLE_TEST_TOKEN` env var
   - Check `Authorization: Bearer <token>` header
   - Timing-safe comparison

2. **Apply middleware to test endpoint** (`src/api/v2/index.ts`)

   ```typescript
   v2Router.post(
     "/assets/test/lifecycle",
     lifecycleTestAuthMiddleware,
     testLifecycleHandler,
   );
   ```

3. **Add CI workflow jobs** (`.github/workflows/deploy-aws.yml`)

   - Add `test_lifecycle_dev` job after `deploy_otr_dev`
   - Add `test_lifecycle_prod` job after `deploy_otr_prod`

   ```yaml
   test_lifecycle_dev:
     name: Test S3 Lifecycle Renewal (Dev)
     runs-on: ubuntu-latest
     needs: deploy_otr_dev
     steps:
       - name: Wait for deployment to stabilize
         run: sleep 30

       - name: Test lifecycle renewal endpoint
         run: |
           response=$(curl -s -w "\n%{http_code}" \
             -X POST "${{ secrets.OTR_DEV_API_URL }}/v2/assets/test/lifecycle" \
             -H "Authorization: Bearer ${{ secrets.LIFECYCLE_TEST_TOKEN }}")
           http_code=$(echo "$response" | tail -1)
           body=$(echo "$response" | head -n -1)
           echo "$body"
           if [ "$http_code" != "200" ] || ! echo "$body" | grep -q '"success":true'; then
             echo "::error::Lifecycle test failed!"
             exit 1
           fi
           echo "✅ Lifecycle renewal test passed (dev)" >> $GITHUB_STEP_SUMMARY

   test_lifecycle_prod:
     name: Test S3 Lifecycle Renewal (Prod)
     runs-on: ubuntu-latest
     needs: deploy_otr_prod
     steps:
       - name: Wait for deployment to stabilize
         run: sleep 30

       - name: Test lifecycle renewal endpoint
         run: |
           response=$(curl -s -w "\n%{http_code}" \
             -X POST "${{ secrets.OTR_PROD_API_URL }}/v2/assets/test/lifecycle" \
             -H "Authorization: Bearer ${{ secrets.LIFECYCLE_TEST_TOKEN }}")
           http_code=$(echo "$response" | tail -1)
           body=$(echo "$response" | head -n -1)
           echo "$body"
           if [ "$http_code" != "200" ] || ! echo "$body" | grep -q '"success":true'; then
             echo "::error::Lifecycle test failed!"
             exit 1
           fi
           echo "✅ Lifecycle renewal test passed (prod)" >> $GITHUB_STEP_SUMMARY
   ```

4. **Add secrets to GitHub**:
   - `LIFECYCLE_TEST_TOKEN` - Secret token for auth
   - `OTR_DEV_API_URL` - Dev API URL
   - `OTR_PROD_API_URL` - Prod API URL

**Files to modify**:

- `src/middleware/lifecycleTestAuth.ts` (new)
- `src/api/v2/index.ts` (add middleware)
- `.github/workflows/deploy-aws.yml` (add test jobs after dev and prod deploys)
- `.env.example` (add LIFECYCLE_TEST_TOKEN)

---

### Part 2: Rolling Verification for Deletion (Daily Cron via GitHub Actions)

**Goal**: Continuously verify that:

- Files NOT renewed get deleted after 24h+
- Files that ARE renewed persist

**Why GitHub Actions**: Simple scheduled workflow, no additional AWS infrastructure needed. Workflow failure triggers email notification.

**Approach - "Canary File System"**:

1. **Create new endpoint** `POST /v2/assets/test/lifecycle-status`

   - Protected by same `LIFECYCLE_TEST_TOKEN`
   - Logic:
     1. Create today's canary files:
        - `canary-delete-YYYY-MM-DD.txt` (will NOT be renewed, should expire)
        - `canary-keep-YYYY-MM-DD.txt` (will be renewed daily)
     2. Renew all existing `canary-keep-*` files (copy-to-self)
     3. Check for files from 2+ days ago:
        - `canary-delete-{2-days-ago}` should NOT exist
        - `canary-keep-{2-days-ago}` SHOULD exist
     4. Return status report

   ```json
   {
     "status": "healthy",
     "date": "2026-01-26",
     "created": {
       "deleteCanary": "canary-delete-2026-01-26.txt",
       "keepCanary": "canary-keep-2026-01-26.txt"
     },
     "renewed": ["canary-keep-2026-01-25.txt", "canary-keep-2026-01-24.txt"],
     "verified": {
       "deletedAsExpected": ["canary-delete-2026-01-24.txt"],
       "existsAsExpected": ["canary-keep-2026-01-24.txt"]
     },
     "errors": []
   }
   ```

2. **Create scheduled GitHub Actions workflow** (`.github/workflows/s3-lifecycle-verify.yml`)

   ```yaml
   name: S3 Lifecycle Verification

   on:
     schedule:
       - cron: "0 6 * * *" # 6 AM UTC daily (after midnight sweep)
     workflow_dispatch: {} # Allow manual trigger

   jobs:
     verify-dev:
       name: Verify Lifecycle (Dev)
       runs-on: ubuntu-latest
       steps:
         - name: Verify S3 lifecycle canaries
           run: |
             response=$(curl -s -w "\n%{http_code}" \
               -X POST "${{ secrets.OTR_DEV_API_URL }}/v2/assets/test/lifecycle-status" \
               -H "Authorization: Bearer ${{ secrets.LIFECYCLE_TEST_TOKEN }}")
             http_code=$(echo "$response" | tail -1)
             body=$(echo "$response" | head -n -1)
             echo "$body" | jq .
             if [ "$http_code" != "200" ] || ! echo "$body" | jq -e '.status == "healthy"' > /dev/null; then
               echo "::error::Lifecycle verification failed!"
               exit 1
             fi
             echo "✅ Lifecycle verification passed (dev)" >> $GITHUB_STEP_SUMMARY

     verify-prod:
       name: Verify Lifecycle (Prod)
       runs-on: ubuntu-latest
       steps:
         - name: Verify S3 lifecycle canaries
           run: |
             response=$(curl -s -w "\n%{http_code}" \
               -X POST "${{ secrets.OTR_PROD_API_URL }}/v2/assets/test/lifecycle-status" \
               -H "Authorization: Bearer ${{ secrets.LIFECYCLE_TEST_TOKEN }}")
             http_code=$(echo "$response" | tail -1)
             body=$(echo "$response" | head -n -1)
             echo "$body" | jq .
             if [ "$http_code" != "200" ] || ! echo "$body" | jq -e '.status == "healthy"' > /dev/null; then
               echo "::error::Lifecycle verification failed!"
               exit 1
             fi
             echo "✅ Lifecycle verification passed (prod)" >> $GITHUB_STEP_SUMMARY
   ```

**Files to create/modify**:

- `src/api/v2/assets/handlers/lifecycle-status.ts` (new)
- `src/api/v2/index.ts` (add route)
- `.github/workflows/s3-lifecycle-verify.yml` (new)

---

## File Summary

| File                                             | Action | Purpose                                       |
| ------------------------------------------------ | ------ | --------------------------------------------- |
| `src/middleware/lifecycleTestAuth.ts`            | Create | Token auth middleware                         |
| `src/api/v2/index.ts`                            | Modify | Add auth to test endpoints                    |
| `src/api/v2/assets/handlers/lifecycle-status.ts` | Create | Daily canary status endpoint (Part 2)         |
| `.github/workflows/deploy-aws.yml`               | Modify | Add lifecycle test after dev and prod deploys |
| `.github/workflows/s3-lifecycle-verify.yml`      | Create | Daily cron verification (Part 2)              |
| `.env.example`                                   | Modify | Document LIFECYCLE_TEST_TOKEN                 |

---

## Verification

### Part 1 (CI Test):

1. Merge to otr-dev to trigger deploy
2. Watch deploy-aws.yml workflow
3. Verify the `test_lifecycle_dev` job runs after `deploy_otr_dev`
4. Check logs show `success: true` from endpoint
5. Repeat for prod after merging to otr-prod

### Part 2 (Rolling Verification):

1. Merge the workflow file to otr-dev
2. Manually trigger `s3-lifecycle-verify.yml` workflow via GitHub Actions UI
3. Wait 48+ hours (need 2 days of canary files to verify deletion)
4. Check workflow runs for daily verification:
   - "Delete" canaries from 2+ days ago are gone
   - "Keep" canaries from 2+ days ago still exist
5. Test alerting by intentionally failing (e.g., delete a "keep" canary) - GitHub will send email on failure

---

## Recommended Phasing

**Phase 1 (This PR)**: Part 1 - CI integration test

- Add token auth to existing endpoint
- Add test jobs to deploy-aws.yml (runs after dev and prod deploys)
- Quick win, catches renewal regressions on every deploy

**Phase 2 (Follow-up PR)**: Part 2 - Rolling verification

- New `/v2/assets/test/lifecycle-status` endpoint with canary system
- GitHub Actions scheduled workflow for daily verification
- No additional AWS infrastructure needed
