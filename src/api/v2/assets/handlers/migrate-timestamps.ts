import {
  CopyObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client,
  type HeadObjectCommandOutput,
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
const MAX_PAGES_PER_REQUEST = 50;
const DEFAULT_MAX_PAGES = 5;
const MIN_VERIFICATION_SAMPLE = 5;
const MAX_VERIFICATION_SAMPLE = 100;
const MAX_RETRY_ATTEMPTS = 4;
const BASE_RETRY_DELAY_MS = 200;
const MAX_RETRY_DELAY_MS = 4000;
const MAX_RETRY_JITTER_MS = 200;

const RETRYABLE_S3_ERROR_NAMES = new Set([
  "SlowDown",
  "Throttling",
  "ThrottlingException",
  "RequestTimeout",
  "ServiceUnavailable",
  "InternalError",
]);

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
  maxPages: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_PAGES_PER_REQUEST)
    .default(DEFAULT_MAX_PAGES),
  continuationToken: z.preprocess((value) => {
    if (typeof value !== "string") {
      return value;
    }
    const trimmed = value.trim();
    return trimmed.length === 0 ? undefined : trimmed;
  }, z.string().max(2048).optional()),
  verbose: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
});

interface MigrateResponse {
  dryRun: boolean;
  bucket: string;
  olderThanDays: number;
  concurrency: number;
  maxPages: number;
  processedPages: number;
  nextContinuationToken: string | null;
  done: boolean;
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
async function forEachWithConcurrency<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let running = 0;
  let index = 0;

  return new Promise((resolve, reject) => {
    function next() {
      if (index >= items.length && running === 0) {
        resolve();
        return;
      }

      while (running < concurrency && index < items.length) {
        const i = index++;
        running++;
        fn(items[i])
          .then(() => {
            running--;
            next();
          })
          .catch(reject);
      }
    }

    next();
  });
}

/**
 * Sleep helper for retry backoff.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function getErrorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

/**
 * Detect retryable S3 errors (throttling/transient service failures).
 */
function isRetryableS3Error(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const httpStatusCode = (
    error as {
      $metadata?: {
        httpStatusCode?: number;
      };
    }
  ).$metadata?.httpStatusCode;

  return (
    RETRYABLE_S3_ERROR_NAMES.has(error.name) ||
    httpStatusCode === 429 ||
    httpStatusCode === 500 ||
    httpStatusCode === 503
  );
}

/**
 * Run an S3 operation with bounded exponential backoff on retryable errors.
 */
async function sendWithRetry<T>(
  req: Request,
  operation: string,
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  for (let attempt = 1; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const isRetryable = isRetryableS3Error(error);
      if (!isRetryable || attempt === MAX_RETRY_ATTEMPTS) {
        throw error;
      }

      const backoffMs = Math.min(
        MAX_RETRY_DELAY_MS,
        BASE_RETRY_DELAY_MS * 2 ** (attempt - 1),
      );
      const jitterMs = Math.floor(Math.random() * MAX_RETRY_JITTER_MS);
      const delayMs = backoffMs + jitterMs;

      req.log.warn(
        { operation, key, attempt, delayMs, errorName: getErrorName(error) },
        "Retrying S3 operation after transient error",
      );
      await sleep(delayMs);
    }
  }

  throw new Error(
    "Retry loop exhausted without returning or throwing (unexpected state)",
  );
}

/**
 * Preserve selected object headers/metadata during copy-to-self operations.
 */
function copyMetadataFromHead(head: HeadObjectCommandOutput) {
  return {
    CacheControl: head.CacheControl,
    ContentDisposition: head.ContentDisposition,
    ContentEncoding: head.ContentEncoding,
    ContentLanguage: head.ContentLanguage,
    ContentType: head.ContentType,
    Metadata: head.Metadata ?? {},
    ServerSideEncryption: head.ServerSideEncryption,
    SSEKMSKeyId: head.SSEKMSKeyId,
    StorageClass: head.StorageClass,
    WebsiteRedirectLocation: head.WebsiteRedirectLocation,
  };
}

/**
 * Keep a bounded random sample with reservoir sampling.
 */
function addReservoirSample(
  samples: string[],
  maxSize: number,
  seenCount: number,
  key: string,
) {
  if (samples.length < maxSize) {
    samples.push(key);
    return;
  }

  const replacementIndex = Math.floor(Math.random() * seenCount);
  if (replacementIndex < maxSize) {
    samples[replacementIndex] = key;
  }
}

/**
 * Pick up to sampleSize random items without mutating the input array.
 */
function pickRandomSamples<T>(items: T[], sampleSize: number): T[] {
  if (sampleSize >= items.length) {
    return [...items];
  }

  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, sampleSize);
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
 *   concurrency=N         (default: 50, max: 200) — parallel copy operations
 *   maxPages=N            (default: 5, max: 50) — pages to process per request
 *   continuationToken=T   (optional) — resume listing from prior chunk token
 *   verbose=true|false    (default: false) — log every successfully renewed key
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

  const { dryRun, olderThanDays, concurrency, maxPages, verbose } = params;
  const startTime = Date.now();
  const startContinuationToken = params.continuationToken;

  req.log.info(
    {
      bucket,
      dryRun,
      olderThanDays,
      concurrency,
      maxPages,
      continuationTokenProvided: Boolean(startContinuationToken),
      verbose,
    },
    "Starting timestamp migration",
  );

  try {
    // Step 1: Validate bucket access
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
    req.log.info({ bucket }, "Bucket access confirmed");

    // Step 2: List all objects with pagination
    const cutoff = new Date();
    cutoff.setUTCDate(cutoff.getUTCDate() - olderThanDays);

    let total = 0;
    let eligible = 0;
    let skipped = 0;
    let renewed = 0;
    let renewedSeenCount = 0;
    const verificationCandidates: string[] = [];
    let continuationToken: string | undefined = startContinuationToken;
    const failedKeys: { key: string; error: string }[] = [];
    let processedPages = 0;

    while (processedPages < maxPages) {
      const listResponse = await client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          ContinuationToken: continuationToken,
        }),
      );

      const pageEligibleKeys: string[] = [];
      for (const obj of listResponse.Contents ?? []) {
        if (!obj.Key) continue;

        total++;
        if (obj.LastModified && obj.LastModified < cutoff) {
          eligible++;
          if (!dryRun) {
            pageEligibleKeys.push(obj.Key);
          }
        } else {
          skipped++;
        }
      }

      if (!dryRun && pageEligibleKeys.length > 0) {
        await forEachWithConcurrency(
          pageEligibleKeys,
          concurrency,
          async (key) => {
            try {
              const sourceHead = await sendWithRetry(
                req,
                "HeadObject",
                key,
                async () =>
                  client.send(
                    new HeadObjectCommand({ Bucket: bucket, Key: key }),
                  ),
              );

              await sendWithRetry(req, "CopyObject", key, async () =>
                client.send(
                  new CopyObjectCommand({
                    Bucket: bucket,
                    CopySource: `${bucket}/${key}`,
                    Key: key,
                    MetadataDirective: "COPY",
                    ...copyMetadataFromHead(sourceHead),
                  }),
                ),
              );

              renewed++;
              if (verbose) {
                req.log.info({ key }, "Renewed object");
              }
              renewedSeenCount++;
              addReservoirSample(
                verificationCandidates,
                MAX_VERIFICATION_SAMPLE,
                renewedSeenCount,
                key,
              );
            } catch (error: unknown) {
              failedKeys.push({
                key,
                error: `${getErrorName(error)}: ${getErrorMessage(error)}`,
              });
              req.log.error({ key, error }, "Failed to renew object");
            }
          },
        );
      }

      continuationToken = listResponse.IsTruncated
        ? listResponse.NextContinuationToken
        : undefined;
      processedPages++;

      req.log.info(
        {
          page: processedPages,
          pageObjects: listResponse.Contents?.length ?? 0,
          total,
          eligible,
          skipped,
          renewed,
          failed: failedKeys.length,
          hasMorePages: Boolean(continuationToken),
          processedPages,
          maxPages,
        },
        "Processed migration listing page",
      );
      if (!continuationToken) {
        break;
      }
    }
    const nextContinuationToken = continuationToken ?? null;
    const done = nextContinuationToken === null;

    req.log.info(
      {
        total,
        eligible,
        skipped,
        processedPages,
        maxPages,
        done,
        hasNextContinuationToken: Boolean(nextContinuationToken),
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
        maxPages,
        processedPages,
        nextContinuationToken,
        done,
        total,
        eligible,
        skipped,
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

    // Step 4: Verify a sample of renewed keys
    const desiredSampleSize =
      renewed === 0
        ? 0
        : Math.max(
            MIN_VERIFICATION_SAMPLE,
            Math.min(MAX_VERIFICATION_SAMPLE, Math.floor(renewed * 0.01)),
          );
    const sampleKeys = pickRandomSamples(
      verificationCandidates,
      Math.min(desiredSampleSize, verificationCandidates.length),
    );

    const verified: { key: string; lastModified: string }[] = [];
    for (const key of sampleKeys) {
      try {
        const head = await sendWithRetry(req, "HeadObject", key, async () =>
          client.send(new HeadObjectCommand({ Bucket: bucket, Key: key })),
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
      maxPages,
      processedPages,
      nextContinuationToken,
      done,
      total,
      eligible,
      skipped,
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
