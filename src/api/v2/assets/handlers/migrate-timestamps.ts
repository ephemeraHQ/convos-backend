import {
  CopyObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import type { Request, Response } from "express";
import { z } from "zod";

const envSchema = z.object({
  PUBLIC_ASSETS_BUCKET: z.string().min(1).optional(),
});

const env = envSchema.parse({
  PUBLIC_ASSETS_BUCKET: process.env.PUBLIC_ASSETS_BUCKET,
});

const s3Client = env.PUBLIC_ASSETS_BUCKET ? new S3Client({}) : null;

const MAX_CONCURRENCY = 200;
const DEFAULT_CONCURRENCY = 50;
const DEFAULT_OLDER_THAN_DAYS = 25;

const querySchema = z.object({
  dryRun: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  olderThanDays: z.coerce
    .number()
    .int()
    .min(0)
    .max(365)
    .default(DEFAULT_OLDER_THAN_DAYS),
  concurrency: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_CONCURRENCY)
    .default(DEFAULT_CONCURRENCY),
});

interface MigrateResponse {
  dryRun: boolean;
  bucket: string;
  olderThanDays: number;
  concurrency: number;
  total: number;
  eligible: number;
  skipped: number;
  renewed: number;
  failed: number;
  failedKeys: { key: string; error: string }[];
  verified: { key: string; lastModified: string }[];
  durationMs: number;
}

/**
 * Process items with bounded concurrency using a simple semaphore.
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let running = 0;
  let index = 0;

  return new Promise((resolve, reject) => {
    function next() {
      while (running < concurrency && index < items.length) {
        const i = index++;
        running++;
        fn(items[i])
          .then((result) => {
            results[i] = result;
            running--;
            if (index >= items.length && running === 0) {
              resolve(results);
            } else {
              next();
            }
          })
          .catch(reject);
      }
    }
    if (items.length === 0) {
      resolve(results);
    } else {
      next();
    }
  });
}

/**
 * POST /v2/assets/test/migrate-timestamps
 *
 * One-time migration endpoint that copies all objects in PUBLIC_ASSETS_BUCKET
 * to themselves, resetting their LastModified timestamp. This gives every
 * object a fresh 30-day window before the S3 lifecycle expiration rule
 * takes effect.
 *
 * Query params:
 *   dryRun=true|false   (default: true) — report counts without copying
 *   olderThanDays=N     (default: 25) — only touch objects older than N days
 *   concurrency=N       (default: 50, max: 200) — parallel copy operations
 *
 * Protected by lifecycleTestAuthMiddleware. Remove after migration is complete.
 */
export async function migrateTimestampsHandler(req: Request, res: Response) {
  if (!env.PUBLIC_ASSETS_BUCKET || !s3Client) {
    res.status(503).json({
      error: "Migration not available - PUBLIC_ASSETS_BUCKET not configured",
    });
    return;
  }

  const bucket = env.PUBLIC_ASSETS_BUCKET;
  const client = s3Client;

  let params: z.infer<typeof querySchema>;
  try {
    params = querySchema.parse(req.query);
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({
        error: "Invalid query parameters",
        details: error.errors,
      });
      return;
    }
    throw error;
  }

  const { dryRun, olderThanDays, concurrency } = params;
  const startTime = Date.now();

  req.log.info(
    { bucket, dryRun, olderThanDays, concurrency },
    "Starting timestamp migration",
  );

  try {
    // Step 1: Validate bucket access
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
    req.log.info({ bucket }, "Bucket access confirmed");

    // Step 2: List all objects with pagination
    const cutoff = new Date();
    cutoff.setUTCDate(cutoff.getUTCDate() - olderThanDays);

    const allKeys: string[] = [];
    const eligibleKeys: string[] = [];
    let continuationToken: string | undefined;

    do {
      const listResponse = await client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          ContinuationToken: continuationToken,
        }),
      );

      for (const obj of listResponse.Contents ?? []) {
        if (!obj.Key) continue;
        allKeys.push(obj.Key);
        if (obj.LastModified && obj.LastModified < cutoff) {
          eligibleKeys.push(obj.Key);
        }
      }

      continuationToken = listResponse.IsTruncated
        ? listResponse.NextContinuationToken
        : undefined;
    } while (continuationToken);

    req.log.info(
      {
        total: allKeys.length,
        eligible: eligibleKeys.length,
        skipped: allKeys.length - eligibleKeys.length,
        cutoff: cutoff.toISOString(),
      },
      "Object listing complete",
    );

    // Step 3: If dry run, return counts without copying
    if (dryRun) {
      const result: MigrateResponse = {
        dryRun: true,
        bucket,
        olderThanDays,
        concurrency,
        total: allKeys.length,
        eligible: eligibleKeys.length,
        skipped: allKeys.length - eligibleKeys.length,
        renewed: 0,
        failed: 0,
        failedKeys: [],
        verified: [],
        durationMs: Date.now() - startTime,
      };

      req.log.info(result, "Dry run complete");
      res.json(result);
      return;
    }

    // Step 4: Copy-to-self with bounded concurrency
    const failedKeys: { key: string; error: string }[] = [];
    let renewed = 0;

    await mapWithConcurrency(eligibleKeys, concurrency, async (key) => {
      try {
        await client.send(
          new CopyObjectCommand({
            Bucket: bucket,
            CopySource: `${bucket}/${encodeURIComponent(key)}`,
            Key: key,
            MetadataDirective: "COPY",
          }),
        );
        renewed++;
      } catch (error: unknown) {
        const message =
          error instanceof Error ? error.message : "Unknown error";
        const errorName = error instanceof Error ? error.name : "UnknownError";
        failedKeys.push({ key, error: `${errorName}: ${message}` });
        req.log.error({ key, error }, "Failed to renew object");
      }
    });

    // Step 5: Verify a sample of renewed keys
    const sampleSize = Math.min(5, renewed);
    const sampleKeys = eligibleKeys
      .filter((k) => !failedKeys.some((f) => f.key === k))
      .slice(0, sampleSize);

    const verified: { key: string; lastModified: string }[] = [];
    for (const key of sampleKeys) {
      try {
        const head = await client.send(
          new HeadObjectCommand({ Bucket: bucket, Key: key }),
        );
        if (head.LastModified) {
          verified.push({
            key,
            lastModified: head.LastModified.toISOString(),
          });
        }
      } catch (error) {
        req.log.warn({ key, error }, "Verification HeadObject failed");
      }
    }

    const result: MigrateResponse = {
      dryRun: false,
      bucket,
      olderThanDays,
      concurrency,
      total: allKeys.length,
      eligible: eligibleKeys.length,
      skipped: allKeys.length - eligibleKeys.length,
      renewed,
      failed: failedKeys.length,
      failedKeys,
      verified,
      durationMs: Date.now() - startTime,
    };

    req.log.info(
      {
        total: result.total,
        eligible: result.eligible,
        renewed: result.renewed,
        failed: result.failed,
        durationMs: result.durationMs,
      },
      "Timestamp migration complete",
    );

    res.json(result);
    return;
  } catch (error) {
    req.log.error({ error }, "Timestamp migration failed");
    res.status(500).json({
      error: "Timestamp migration failed",
      details: error instanceof Error ? error.message : "Unknown error",
    });
    return;
  }
}
