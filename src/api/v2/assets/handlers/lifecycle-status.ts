import {
  CopyObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { Request, Response } from "express";
import { z } from "zod";

const envSchema = z.object({
  LIFECYCLE_TEST_BUCKET: z.string().optional(),
});

const env = envSchema.parse({
  LIFECYCLE_TEST_BUCKET: process.env.LIFECYCLE_TEST_BUCKET,
});

const s3Client = env.LIFECYCLE_TEST_BUCKET ? new S3Client({}) : null;

// Verification window constants
const MIN_VERIFICATION_DAYS = 3; // S3 lifecycle: file created Day X → expires at midnight Day X+1 → batch-deleted during Day X+2. Verify on Day X+3.
const MAX_VERIFICATION_DAYS = 7; // Window for historical verification

/**
 * Format a date as YYYY-MM-DD
 */
function formatDate(date: Date): string {
  return date.toISOString().split("T")[0];
}

/**
 * Get a date N days ago from a reference date (using UTC to match formatDate)
 */
function daysAgo(days: number, from: Date): Date {
  const date = new Date(from);
  date.setUTCDate(date.getUTCDate() - days);
  return date;
}

/**
 * Check if an S3 object exists
 */
async function objectExists(
  client: S3Client,
  bucket: string,
  key: string,
): Promise<boolean> {
  try {
    await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      (error.name === "NotFound" || error.name === "NoSuchKey")
    ) {
      return false;
    }
    throw error;
  }
}

/**
 * Copy an object to itself to reset its LastModified timestamp (renewal)
 */
async function renewObject(
  client: S3Client,
  bucket: string,
  key: string,
): Promise<void> {
  // Matches renew-batch.ts implementation - COPY preserves metadata
  await client.send(
    new CopyObjectCommand({
      Bucket: bucket,
      CopySource: `${bucket}/${encodeURIComponent(key)}`,
      Key: key,
      MetadataDirective: "COPY",
    }),
  );
}

interface LifecycleStatusResult {
  status: "healthy" | "unhealthy";
  date: string;
  created: {
    deleteCanary: string;
    keepCanary: string;
  };
  renewed: string[];
  verified: {
    deletedAsExpected: string[];
    existsAsExpected: string[];
  };
  cleaned: string[];
  errors: string[];
}

/**
 * POST /v2/assets/test/lifecycle-status
 *
 * Daily canary verification endpoint for S3 lifecycle policy.
 *
 * This endpoint:
 * 1. Creates today's canary files (delete and keep variants)
 * 2. Renews all existing "keep" canaries (copy-to-self)
 * 3. Verifies files from 2+ days ago behave correctly:
 *    - "delete" canaries should NOT exist (expired by lifecycle policy)
 *    - "keep" canaries SHOULD exist (renewed daily)
 * 4. Returns a status report
 *
 * Run daily via GitHub Actions scheduled workflow.
 */
export async function lifecycleStatusHandler(req: Request, res: Response) {
  if (!env.LIFECYCLE_TEST_BUCKET || !s3Client) {
    res.status(503).json({
      error:
        "Lifecycle status not available - LIFECYCLE_TEST_BUCKET not configured",
    });
    return;
  }

  // Capture narrowed values for use in async callbacks
  // (TypeScript's control flow analysis doesn't maintain narrowing inside .map() callbacks)
  const bucket = env.LIFECYCLE_TEST_BUCKET;
  const client = s3Client;

  const now = new Date();
  const today = formatDate(now);
  const deleteCanaryKey = `canary-delete-${today}.txt`;
  const keepCanaryKey = `canary-keep-${today}.txt`;

  const result: LifecycleStatusResult = {
    status: "healthy",
    date: today,
    created: {
      deleteCanary: deleteCanaryKey,
      keepCanary: keepCanaryKey,
    },
    renewed: [],
    verified: {
      deletedAsExpected: [],
      existsAsExpected: [],
    },
    cleaned: [],
    errors: [],
  };

  try {
    req.log.info({ today }, "Starting lifecycle status check");

    // Step 1: Create today's canary files
    const canaryContent = `Canary file created at ${now.toISOString()}`;

    // Create delete canary (will NOT be renewed, should expire after 24h)
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: deleteCanaryKey,
        Body: canaryContent,
        ContentType: "text/plain",
      }),
    );
    req.log.info({ key: deleteCanaryKey }, "Created delete canary");

    // Create keep canary (will be renewed daily)
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: keepCanaryKey,
        Body: canaryContent,
        ContentType: "text/plain",
      }),
    );
    req.log.info({ key: keepCanaryKey }, "Created keep canary");

    // Step 2: List and renew all existing "keep" canaries (in parallel)
    // Note: Pagination not needed - cleanup step keeps total canaries under 20
    const listResponse = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: "canary-keep-",
      }),
    );

    const keepCanaries = (listResponse.Contents ?? [])
      .map((obj) => obj.Key)
      .filter((key): key is string => key !== undefined);

    // Parallel renewal for better performance
    const renewalResults = await Promise.allSettled(
      keepCanaries.map(async (key) => {
        await renewObject(client, bucket, key);
        return key;
      }),
    );

    for (const [index, settledResult] of renewalResults.entries()) {
      const key = keepCanaries[index];
      if (settledResult.status === "fulfilled") {
        result.renewed.push(key);
        req.log.info({ key }, "Renewed keep canary");
      } else {
        const error: unknown = settledResult.reason;
        const message = `Failed to renew ${key}: ${error instanceof Error ? error.message : "Unknown error"}`;
        result.errors.push(message);
        req.log.error({ key, error }, "Failed to renew keep canary");
      }
    }

    // Determine oldest keep canary date for cold-start detection
    // Keys are like "canary-keep-2026-01-20.txt", sorted lexicographically = chronologically
    const oldestKeepDate = keepCanaries.reduce<string | null>((oldest, key) => {
      const match = key.match(/canary-keep-(\d{4}-\d{2}-\d{2})\.txt/);
      if (!match) return oldest;
      const date = match[1];
      return oldest === null || date < oldest ? date : oldest;
    }, null);

    // Step 3: Verify files from 2+ days ago (in parallel)
    // Check days MIN_VERIFICATION_DAYS to MAX_VERIFICATION_DAYS to catch any issues
    const daysToCheck: number[] = [];
    for (let d = MIN_VERIFICATION_DAYS; d <= MAX_VERIFICATION_DAYS; d++) {
      daysToCheck.push(d);
    }

    // Build verification tasks
    const verificationTasks = daysToCheck.flatMap((daysBack) => {
      const checkDate = formatDate(daysAgo(daysBack, now));
      return [
        {
          type: "delete" as const,
          daysBack,
          checkDate,
          key: `canary-delete-${checkDate}.txt`,
        },
        {
          type: "keep" as const,
          daysBack,
          checkDate,
          key: `canary-keep-${checkDate}.txt`,
        },
      ];
    });

    // Run all existence checks in parallel
    const existenceResults = await Promise.all(
      verificationTasks.map(async (task) => ({
        ...task,
        exists: await objectExists(client, bucket, task.key),
      })),
    );

    // Process results
    for (const { type, key, checkDate, exists } of existenceResults) {
      if (type === "delete") {
        // Delete canary should NOT exist (expired)
        if (!exists) {
          result.verified.deletedAsExpected.push(key);
          req.log.info({ key }, "Delete canary correctly expired");
        } else {
          const message = `Delete canary ${key} still exists (should have expired)`;
          result.errors.push(message);
          result.status = "unhealthy";
          req.log.error({ key }, "Delete canary did NOT expire");
        }
      } else {
        // Keep canary SHOULD exist (renewed daily)
        if (exists) {
          result.verified.existsAsExpected.push(key);
          req.log.info({ key }, "Keep canary correctly persisted");
        } else if (oldestKeepDate !== null && checkDate >= oldestKeepDate) {
          // System was running on this date (we have a canary from the same
          // day or earlier), so a missing keep canary is a real failure
          const message = `Keep canary ${key} missing (renewal may be broken)`;
          result.errors.push(message);
          result.status = "unhealthy";
          req.log.error({ key }, "Keep canary missing after cold start period");
        } else {
          // Cold start: this date is before the oldest canary, system wasn't running yet
          req.log.info(
            { key },
            "Keep canary not found (expected during cold start)",
          );
        }
      }
    }

    // Step 4: Clean up old canaries to prevent accumulation
    // Delete keep canaries older than MAX_VERIFICATION_DAYS (they've been verified)
    const cutoffDate = formatDate(daysAgo(MAX_VERIFICATION_DAYS, now));
    const oldKeepCanaries = keepCanaries.filter((key) => {
      // Extract date from key like "canary-keep-2026-01-20.txt"
      const match = key.match(/canary-keep-(\d{4}-\d{2}-\d{2})\.txt/);
      if (!match) return false;
      const canaryDate = match[1];
      return canaryDate < cutoffDate; // String comparison works for YYYY-MM-DD format
    });

    // Delete old canaries in parallel
    const cleanupResults = await Promise.allSettled(
      oldKeepCanaries.map(async (key) => {
        await client.send(
          new DeleteObjectCommand({
            Bucket: bucket,
            Key: key,
          }),
        );
        return key;
      }),
    );

    for (const [index, settledResult] of cleanupResults.entries()) {
      const key = oldKeepCanaries[index];
      if (settledResult.status === "fulfilled") {
        result.cleaned.push(key);
        req.log.info({ key }, "Cleaned up old keep canary");
      } else {
        const error: unknown = settledResult.reason;
        req.log.warn(
          { key, error },
          "Failed to clean up old keep canary (non-critical)",
        );
      }
    }

    req.log.info(
      {
        status: result.status,
        renewed: result.renewed.length,
        cleaned: result.cleaned.length,
        errors: result.errors.length,
      },
      "Lifecycle status check completed",
    );

    res.json(result);
    return;
  } catch (error) {
    req.log.error({ error }, "Lifecycle status check failed");
    res.status(500).json({
      error: "Lifecycle status check failed",
      details: error instanceof Error ? error.message : "Unknown error",
    });
    return;
  }
}
