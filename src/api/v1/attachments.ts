import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Router, type Request, type Response } from "express";
import mime from "mime-types";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";

const envSchema = z.object({
  SCALEWAY_ACCESS_KEY_ID: z.string().min(1),
  SCALEWAY_SECRET_KEY_ID: z.string().min(1),
  SCALEWAY_ATTACHMENTS_BUCKET: z.string().min(1),
});

// Validate environment variables at startup
const env = envSchema.parse({
  SCALEWAY_ACCESS_KEY_ID: process.env.SCALEWAY_ACCESS_KEY_ID,
  SCALEWAY_SECRET_KEY_ID: process.env.SCALEWAY_SECRET_KEY_ID,
  SCALEWAY_ATTACHMENTS_BUCKET: process.env.SCALEWAY_ATTACHMENTS_BUCKET,
});

// Create S3 client once at startup
const s3Client = new S3Client({
  endpoint: `https://s3.fr-par.scw.cloud`,
  region: "fr-par",
  credentials: {
    accessKeyId: env.SCALEWAY_ACCESS_KEY_ID,
    secretAccessKey: env.SCALEWAY_SECRET_KEY_ID,
  },
});

const getPresignedURL = async (contentType?: string) => {
  const objectKey = uuidv4();
  let extension: string | undefined;
  if (contentType && mime.extension(contentType)) {
    extension = mime.extension(contentType) as string;
  }
  const command = new PutObjectCommand({
    Bucket: env.SCALEWAY_ATTACHMENTS_BUCKET,
    Key: `${objectKey}${extension ? `.${extension}` : ""}`,
    ACL: "public-read",
    ContentType: contentType,
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
  } catch (error) {
    console.error("Error generating presigned URL:", error);
    res.status(500).json({ error: "Failed to generate presigned URL" });
  }
});

export default router;
