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
 * `contentType` is validated against the attachment allowlist; an unsupported
 * type 400s before a key is minted.
 */

import type { Request, Response } from "express";
import { AppError } from "@/utils/errors";
import { presignBuildUpload } from "../services/build-attachments";

export async function buildAttachmentPresignedHandler(
  req: Request,
  res: Response,
) {
  try {
    const contentType = req.query.contentType;
    if (typeof contentType !== "string" || contentType.trim().length === 0) {
      res
        .status(400)
        .json({ error: "contentType query parameter is required" });
      return;
    }

    const { objectKey, uploadUrl } = await presignBuildUpload(
      contentType.trim(),
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
