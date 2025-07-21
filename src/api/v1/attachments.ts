import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Router, type Request, type Response } from "express";
import mime from "mime-types";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";

const envSchema = z.object({
  PUBLIC_ASSETS_BUCKET: z.string().min(1),
  AWS_REGION: z.string().optional(), // Optional - can be inferred from AWS environment
});

// Validate environment variables at startup
const env = envSchema.parse({
  PUBLIC_ASSETS_BUCKET: process.env.PUBLIC_ASSETS_BUCKET,
});

// Create S3 client once at startup
// No credentials needed - will use IAM role automatically
const s3Client = new S3Client({});

const getPresignedURL = async (contentType?: string) => {
  const objectKey = uuidv4();
  let extension: string | undefined;
  if (contentType && mime.extension(contentType)) {
    extension = mime.extension(contentType) as string;
  }
  const command = new PutObjectCommand({
    Bucket: env.PUBLIC_ASSETS_BUCKET,
    Key: `${objectKey}${extension ? `.${extension}` : ""}`,
    ContentType: contentType,
    // No ACL needed - bucket policy handles public read access
  });
  const url = await getSignedUrl(s3Client, command, { expiresIn: 3600 });
  return { objectKey, url };
};

const router = Router();

router.get("/presigned", async (req: Request, res: Response) => {
  try {
    const { objectKey, url } = await getPresignedURL(
      req.query.contentType as string | undefined,
    );
    res.json({ objectKey, url });
    return;
  } catch (error) {
    console.error("Error generating presigned URL:", error);
    res.status(500).json({ error: "Failed to generate presigned URL" });
    return;
  }
});

export default router;
