import { CopyObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { Request, Response } from "express";
import { z } from "zod";
import { AppError } from "@/utils/errors";

const envSchema = z.object({
  PUBLIC_ASSETS_BUCKET: z.string().min(1).optional(),
  AWS_REGION: z.string().optional(),
});

const env = envSchema.parse({
  PUBLIC_ASSETS_BUCKET: process.env.PUBLIC_ASSETS_BUCKET,
  AWS_REGION: process.env.AWS_REGION,
});

const s3Client = env.PUBLIC_ASSETS_BUCKET ? new S3Client({}) : null;

const MAX_BATCH_SIZE = 100;

const renewBatchRequestSchema = z.object({
  assetKeys: z
    .array(z.string().min(1))
    .min(1, "assetKeys must be a non-empty array")
    .max(MAX_BATCH_SIZE, `Maximum ${MAX_BATCH_SIZE} keys per request`),
});

interface RenewResult {
  key: string;
  success: boolean;
  error?: string;
}

/**
 * Validates that a key is safe to use with S3.
 * Rejects empty keys, path traversal attempts, and leading slashes.
 */
function isValidKey(key: string): boolean {
  return key.length > 0 && !key.includes("..") && !key.startsWith("/");
}

/**
 * POST /v2/assets/renew-batch
 *
 * Renews multiple S3 assets by performing copy-to-self operations,
 * which resets their LastModified timestamp and extends the lifecycle.
 */
export async function renewBatchHandler(req: Request, res: Response) {
  const deviceId = res.locals.deviceId;

  if (!env.PUBLIC_ASSETS_BUCKET || !s3Client) {
    req.log.warn({ deviceId }, "Asset renewal attempted but S3 not configured");
    res.status(503).json({
      error: "Asset renewal not available - S3 not configured",
    });
    return;
  }

  try {
    const body = renewBatchRequestSchema.parse(req.body);
    const { assetKeys } = body;

    req.log.info(
      {
        deviceId,
        keyCount: assetKeys.length,
      },
      "Asset batch renewal request",
    );

    // Process all keys in parallel
    const results: RenewResult[] = await Promise.all(
      assetKeys.map(async (key): Promise<RenewResult> => {
        if (!isValidKey(key)) {
          return { key, success: false, error: "invalid_key" };
        }

        try {
          // Copy object to itself (resets LastModified)
          // CopyObject will fail if not found — no need to HeadObject first
          await s3Client.send(
            new CopyObjectCommand({
              Bucket: env.PUBLIC_ASSETS_BUCKET,
              CopySource: `${env.PUBLIC_ASSETS_BUCKET}/${key}`,
              Key: key,
              MetadataDirective: "COPY",
            }),
          );

          return { key, success: true };
        } catch (error: unknown) {
          const errorName =
            error instanceof Error ? error.name : "UnknownError";

          if (errorName === "NoSuchKey" || errorName === "NotFound") {
            return { key, success: false, error: "not_found" };
          }

          req.log.error(
            { error, key, errorName },
            "Unexpected S3 error during renewal",
          );
          return { key, success: false, error: "internal_error" };
        }
      }),
    );

    const renewed = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success).length;

    req.log.info(
      {
        deviceId,
        keyCount: assetKeys.length,
        renewed,
        failed,
      },
      "Asset batch renewal completed",
    );

    res.json({ renewed, failed, results });
    return;
  } catch (error) {
    if (error instanceof z.ZodError) {
      req.log.warn(
        { errors: error.errors, deviceId },
        "Invalid request body for renew-batch",
      );
      res.status(400).json({
        error: error.errors[0]?.message || "Invalid request body",
      });
      return;
    }

    req.log.error({ error, deviceId }, "Failed to process batch renewal");

    if (error instanceof AppError) {
      res.status(error.statusCode).json({ error: error.message });
      return;
    }

    res.status(500).json({ error: "Failed to renew assets" });
    return;
  }
}
