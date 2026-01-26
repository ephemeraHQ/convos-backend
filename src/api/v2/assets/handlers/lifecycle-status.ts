import {
  CopyObjectCommand,
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

/**
 * Format a date as YYYY-MM-DD
 */
function formatDate(date: Date): string {
  return date.toISOString().split("T")[0];
}

/**
 * Get a date N days ago
 */
function daysAgo(days: number): Date {
  const date = new Date();
  date.setDate(date.getDate() - days);
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

  const today = formatDate(new Date());
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
    errors: [],
  };

  try {
    req.log.info({ today }, "Starting lifecycle status check");

    // Step 1: Create today's canary files
    const canaryContent = `Canary file created at ${new Date().toISOString()}`;

    // Create delete canary (will NOT be renewed, should expire after 24h)
    await s3Client.send(
      new PutObjectCommand({
        Bucket: env.LIFECYCLE_TEST_BUCKET,
        Key: deleteCanaryKey,
        Body: canaryContent,
        ContentType: "text/plain",
      }),
    );
    req.log.info({ key: deleteCanaryKey }, "Created delete canary");

    // Create keep canary (will be renewed daily)
    await s3Client.send(
      new PutObjectCommand({
        Bucket: env.LIFECYCLE_TEST_BUCKET,
        Key: keepCanaryKey,
        Body: canaryContent,
        ContentType: "text/plain",
      }),
    );
    req.log.info({ key: keepCanaryKey }, "Created keep canary");

    // Step 2: List and renew all existing "keep" canaries
    const listResponse = await s3Client.send(
      new ListObjectsV2Command({
        Bucket: env.LIFECYCLE_TEST_BUCKET,
        Prefix: "canary-keep-",
      }),
    );

    const keepCanaries = (listResponse.Contents ?? [])
      .map((obj) => obj.Key)
      .filter((key): key is string => key !== undefined);

    for (const key of keepCanaries) {
      try {
        await renewObject(s3Client, env.LIFECYCLE_TEST_BUCKET, key);
        result.renewed.push(key);
        req.log.info({ key }, "Renewed keep canary");
      } catch (error) {
        const message = `Failed to renew ${key}: ${error instanceof Error ? error.message : "Unknown error"}`;
        result.errors.push(message);
        req.log.error({ key, error }, "Failed to renew keep canary");
      }
    }

    // Step 3: Verify files from 2+ days ago
    // Check days 2-7 to catch any issues
    for (let daysBack = 2; daysBack <= 7; daysBack++) {
      const checkDate = formatDate(daysAgo(daysBack));
      const deleteKey = `canary-delete-${checkDate}.txt`;
      const keepKey = `canary-keep-${checkDate}.txt`;

      // Delete canary should NOT exist (expired)
      const deleteExists = await objectExists(
        s3Client,
        env.LIFECYCLE_TEST_BUCKET,
        deleteKey,
      );
      if (!deleteExists) {
        result.verified.deletedAsExpected.push(deleteKey);
        req.log.info({ key: deleteKey }, "Delete canary correctly expired");
      } else {
        const message = `Delete canary ${deleteKey} still exists (should have expired)`;
        result.errors.push(message);
        result.status = "unhealthy";
        req.log.error({ key: deleteKey }, "Delete canary did NOT expire");
      }

      // Keep canary SHOULD exist (renewed daily)
      const keepExists = await objectExists(
        s3Client,
        env.LIFECYCLE_TEST_BUCKET,
        keepKey,
      );
      if (keepExists) {
        result.verified.existsAsExpected.push(keepKey);
        req.log.info({ key: keepKey }, "Keep canary correctly persisted");
      } else {
        // Only flag as error if the canary should have been created
        // (i.e., if we've been running for that many days)
        const message = `Keep canary ${keepKey} not found (may not have been created yet or was deleted)`;
        result.errors.push(message);
        result.status = "unhealthy";
        req.log.warn({ key: keepKey }, "Keep canary not found");
      }
    }

    req.log.info(
      {
        status: result.status,
        renewed: result.renewed.length,
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
