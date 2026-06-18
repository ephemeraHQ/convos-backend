/**
 * Handler for GET /api/v2/agent-templates/attachments/presigned
 *
 * Mints a presigned PUT so the builder can upload one generation attachment
 * (image / PDF / voice) to the private bucket. The caller echoes the returned
 * `objectKey` back in `inputs.attachments[]` on the generation request; the
 * backend reads the bytes itself for generation + moderation, so no public
 * asset URL is returned.
 *
 * Auth mirrors the generation endpoint (optional): anonymous builds upload too.
 * Because the PUT is an anonymous write capability, `contentLength` (the exact
 * upload size) is required and signed into the URL so S3 caps the upload itself.
 * `contentType` is validated against the attachment allowlist; an unsupported
 * type or an over-cap size 400s before a key is minted.
 */

import type { Request, Response } from "express";
import { z } from "zod";
import { AppError } from "@/utils/errors";
import { presignBuildUpload } from "../services/build-attachments";

const presignedQuerySchema = z.object({
  contentType: z.string().trim().min(1),
  // Query strings are strings; coerce to a positive integer byte count. The
  // per-kind cap is enforced (and the value signed) in presignBuildUpload.
  contentLength: z.coerce.number().int().positive(),
});

export async function buildAttachmentPresignedHandler(
  req: Request,
  res: Response,
) {
  const parsed = presignedQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({
      error: "contentType and a positive contentLength are required",
    });
    return;
  }

  try {
    const { objectKey, uploadUrl } = await presignBuildUpload(
      parsed.data.contentType,
      parsed.data.contentLength,
    );

    res.set({
      "Cache-Control": "no-store",
      Pragma: "no-cache",
      Expires: "0",
    });
    res.json({ objectKey, uploadUrl });
    return;
  } catch (error) {
    req.log.error({ error }, "Error generating build attachment presigned URL");
    if (error instanceof AppError) {
      res.status(error.statusCode).json({ error: error.message });
      return;
    }
    res.status(500).json({ error: "Failed to generate presigned URL" });
    return;
  }
}
