import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import { accountIdSchema } from "@/utils/account-id";
import { AppError } from "@/utils/errors";
import { prisma } from "@/utils/prisma";

const envSchema = z.object({
  PUBLIC_ASSETS_BUCKET: z.string().min(1).optional(),
  AWS_REGION: z.string().optional(),
  CDN_BASE_URL: z.string().url().optional(),
});

const env = envSchema.parse({
  PUBLIC_ASSETS_BUCKET: process.env.PUBLIC_ASSETS_BUCKET,
  AWS_REGION: process.env.AWS_REGION,
  CDN_BASE_URL: process.env.CDN_BASE_URL,
});

const s3Client = env.PUBLIC_ASSETS_BUCKET ? new S3Client({}) : null;

const querySchema = z.object({
  // The trusted agent-key caller may attribute the upload to the same owner
  // it asserts when creating a template. JWT callers always use their own
  // authenticated account and cannot override it.
  ownerAccountId: accountIdSchema.optional(),
});

const getAgentPresignedURL = async (accountId: string) => {
  if (!env.PUBLIC_ASSETS_BUCKET || !s3Client) {
    throw new AppError(503, "File uploads not available - S3 not configured");
  }

  const objectKey = `a/${accountId}/${uuidv4()}`;

  const command = new PutObjectCommand({
    Bucket: env.PUBLIC_ASSETS_BUCKET,
    Key: objectKey,
    ContentType: "application/octet-stream",
  });

  const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: 3600 });
  const assetUrl = env.CDN_BASE_URL
    ? `${env.CDN_BASE_URL.replace(/\/+$/, "")}/${objectKey}`
    : null;

  return { objectKey, uploadUrl, assetUrl };
};

export async function getAgentPresignedUrlHandler(req: Request, res: Response) {
  try {
    const query = querySchema.safeParse(req.query);
    if (!query.success) {
      res.status(400).json({ error: "Invalid ownerAccountId" });
      return;
    }

    let accountId = res.locals.accountId;
    if (
      res.locals.isApiKeyListener === true &&
      query.data.ownerAccountId !== undefined
    ) {
      const assertedOwner = await prisma.account.findUnique({
        where: { id: query.data.ownerAccountId },
        select: { id: true },
      });
      if (!assertedOwner) {
        res
          .status(400)
          .json({ error: "Asserted ownerAccountId does not exist" });
        return;
      }
      accountId = assertedOwner.id;
    }
    if (!accountId) {
      res.status(403).json({ error: "Account required" });
      return;
    }

    req.log.info({ accountId }, "v2 agent assets presigned URL request");

    const { objectKey, uploadUrl, assetUrl } =
      await getAgentPresignedURL(accountId);

    res.set({
      "Cache-Control": "no-store",
      Pragma: "no-cache",
      Expires: "0",
    });

    res.json({
      objectKey,
      url: uploadUrl, // @deprecated - use uploadUrl instead
      uploadUrl,
      assetUrl,
    });
    return;
  } catch (error) {
    req.log.error({ error }, "Error generating agent assets presigned URL");

    if (error instanceof AppError) {
      res.status(error.statusCode).json({ error: error.message });
      return;
    }

    res.status(500).json({ error: "Failed to generate presigned URL" });
    return;
  }
}
