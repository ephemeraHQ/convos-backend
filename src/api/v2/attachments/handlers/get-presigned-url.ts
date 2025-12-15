import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { Request, Response } from "express";
import mime from "mime-types";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import { AppError } from "@/utils/errors";

const envSchema = z.object({
  PUBLIC_ASSETS_BUCKET: z.string().min(1).optional(),
  AWS_REGION: z.string().optional(),
  CDN_BASE_URL: z.string().url().optional(),
});

// Validate environment variables at startup
const env = envSchema.parse({
  PUBLIC_ASSETS_BUCKET: process.env.PUBLIC_ASSETS_BUCKET,
  AWS_REGION: process.env.AWS_REGION,
  CDN_BASE_URL: process.env.CDN_BASE_URL,
});

// Create S3 client only if bucket is configured
const s3Client = env.PUBLIC_ASSETS_BUCKET ? new S3Client({}) : null;

const getPresignedURL = async (contentType?: string) => {
  if (!env.PUBLIC_ASSETS_BUCKET || !s3Client) {
    throw new AppError(503, "File uploads not available - S3 not configured");
  }

  const objectKey = uuidv4();
  const extension = contentType ? mime.extension(contentType) : false;
  const key = `${objectKey}${extension ? `.${extension}` : ""}`;

  const command = new PutObjectCommand({
    Bucket: env.PUBLIC_ASSETS_BUCKET,
    Key: key,
    ContentType: contentType,
  });

  const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: 3600 });
  const assetUrl = env.CDN_BASE_URL ? `${env.CDN_BASE_URL}/${key}` : null;

  return { objectKey: key, uploadUrl, assetUrl };
};

export async function getPresignedUrlHandler(req: Request, res: Response) {
  try {
    const contentType = req.query.contentType as string | undefined;
    const deviceId = res.locals.deviceId;

    req.log.info(
      {
        deviceId,
        contentType,
        hasJwtMetadata: !!res.locals.jwtMetadata,
      },
      "v2 attachments presigned URL request",
    );

    const { objectKey, uploadUrl, assetUrl } =
      await getPresignedURL(contentType);

    res.json({ objectKey, uploadUrl, assetUrl });
    return;
  } catch (error) {
    req.log.error({ error }, "Error generating presigned URL");

    if (error instanceof AppError) {
      res.status(error.statusCode).json({ error: error.message });
      return;
    }

    res.status(500).json({ error: "Failed to generate presigned URL" });
    return;
  }
}
