/**
 * Build-attachment storage — private-bucket upload + backend byte-fetch for the
 * agent-template generator.
 *
 * The builder uploads each generation attachment (image / PDF / voice) to the
 * PRIVATE_ASSETS_BUCKET via a presigned PUT, then sends the generation request
 * lightweight `{ objectKey, mimeType, filename? }` references instead of base64
 * bytes. The backend reads the bytes itself (`GetObject`) for generation +
 * moderation, so decrypted conversation content never gets a public CDN URL.
 *
 * This is the only place in the codebase that reads object BYTES from S3
 * (`GetObjectCommand`); the rest of the asset machinery only HEAD/COPY/DELETEs.
 * Presign + head reuse the existing S3 client + presigner surface.
 *
 * Object keys are namespaced under `build/` and validated on every read so a
 * caller can't point the generator at an arbitrary object in a shared private
 * bucket.
 */

import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import mime from "mime-types";
import { v4 as uuidv4 } from "uuid";
import { PRIVATE_ASSETS_BUCKET } from "@/config";
import { AppError } from "@/utils/errors";

// ---------------------------------------------------------------------------
// Allowlist + per-class size caps
// ---------------------------------------------------------------------------

/** What the generator can do with an attachment. `image`/`pdf` become LLM
 *  content blocks; `audio` is transcribed to text before generation. */
export type AttachmentKind = "image" | "pdf" | "audio";

// Per-file byte caps, set against real model ceilings rather than the bucket's
// physical limit. Images go to a vision model as an inline data URI, so they're
// capped tight (Claude resizes/limits large images anyway); PDFs and audio are
// processed server-side and can be larger. The aggregate cap across all
// attachments lives in config (BUILD_ATTACHMENTS_MAX_TOTAL_BYTES).
const MAX_BYTES_BY_KIND: Record<AttachmentKind, number> = {
  image: 10 * 1024 * 1024,
  pdf: 25 * 1024 * 1024,
  audio: 25 * 1024 * 1024,
};

/** MIME → kind allowlist. Anything not here is rejected at submit time.
 *  Images are PNG/JPEG only — the formats AWS Rekognition can read — so every
 *  accepted image is moderatable (webp/gif would fail moderation open). Audio
 *  covers the common mobile-recording containers (m4a/aac on iOS, ogg/webm on
 *  Android) plus mp3/wav; actual transcription-model format support is a
 *  separate concern handled in services/transcribe.ts. */
const KIND_BY_MIME: Record<string, AttachmentKind> = {
  "image/png": "image",
  "image/jpeg": "image",
  "application/pdf": "pdf",
  "audio/mp4": "audio",
  "audio/m4a": "audio",
  "audio/x-m4a": "audio",
  "audio/aac": "audio",
  "audio/mpeg": "audio",
  "audio/wav": "audio",
  "audio/x-wav": "audio",
  "audio/ogg": "audio",
  "audio/webm": "audio",
};

/** Normalize a wire MIME type: lowercase + strip parameters (`; codecs=…`).
 *  Shared by the resolver + transcriber so every site canonicalizes identically. */
export function normalizeMime(mimeType: string): string {
  return mimeType.split(";")[0].trim().toLowerCase();
}

/** Classify an attachment MIME type, or null if it's not an allowed type. */
export function classifyMime(mimeType: string): AttachmentKind | null {
  return KIND_BY_MIME[normalizeMime(mimeType)] ?? null;
}

/** Per-file byte cap for a kind. */
export function maxBytesForKind(kind: AttachmentKind): number {
  return MAX_BYTES_BY_KIND[kind];
}

// ---------------------------------------------------------------------------
// S3 client (private bucket)
// ---------------------------------------------------------------------------

// Ambient credentials/region (instance role / AWS_* env), mirroring the public
// presigned handlers. Null when the bucket isn't configured → callers 503.
const s3Client = PRIVATE_ASSETS_BUCKET ? new S3Client({}) : null;

function requireBucket(): { bucket: string; client: S3Client } {
  if (!PRIVATE_ASSETS_BUCKET || !s3Client) {
    throw new AppError(
      503,
      "Attachment uploads not available — S3 not configured",
    );
  }
  return { bucket: PRIVATE_ASSETS_BUCKET, client: s3Client };
}

// Object keys this service mints + accepts. The `build/` prefix is load-bearing:
// the private bucket may also hold other private content, so reads are fenced to
// keys this service issued.
const BUILD_KEY_RE = /^build\/[A-Za-z0-9._/-]+$/;

function assertBuildKey(objectKey: string): void {
  // Reject `..` path segments defensively (not a real S3 escape, but keeps keys
  // canonical) in addition to the prefix/charset check.
  if (!BUILD_KEY_RE.test(objectKey) || objectKey.split("/").includes("..")) {
    throw new AppError(400, `Invalid attachment objectKey: ${objectKey}`);
  }
}

/** True for an S3 "object does not exist" error (Head/Get on a missing key). */
function isNotFound(err: unknown): boolean {
  const e = err as
    | { name?: string; $metadata?: { httpStatusCode?: number } }
    | null
    | undefined;
  return (
    e?.name === "NotFound" ||
    e?.name === "NoSuchKey" ||
    e?.$metadata?.httpStatusCode === 404
  );
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

export interface PresignedBuildUpload {
  objectKey: string;
  uploadUrl: string;
}

/** Mint a presigned PUT for a new build attachment. The returned `objectKey` is
 *  what the client echoes back in `inputs.attachments[]`. No public asset URL is
 *  returned — the bucket is private and only the backend reads it.
 *
 *  `contentLength` (the exact byte size the client will upload) is required and
 *  capped at the per-kind limit. It is signed into the URL: the presigned PUT is
 *  an anonymous write capability, so a declared-size check alone is bypassable —
 *  a client could request a small size and then upload an arbitrarily large body.
 *  Signing `content-length` makes S3 itself reject any PUT whose length differs,
 *  so the cap holds without the backend in the upload path. */
export async function presignBuildUpload(
  contentType: string,
  contentLength: number,
): Promise<PresignedBuildUpload> {
  const { bucket, client } = requireBucket();
  const kind = classifyMime(contentType);
  if (!kind) {
    throw new AppError(400, `Unsupported attachment type: ${contentType}`);
  }
  if (!Number.isInteger(contentLength) || contentLength <= 0) {
    throw new AppError(400, "contentLength must be a positive integer");
  }
  const max = maxBytesForKind(kind);
  if (contentLength > max) {
    throw new AppError(
      400,
      `Attachment exceeds the ${kind} size limit of ${max} bytes`,
    );
  }
  const ext = mime.extension(contentType);
  const objectKey = `build/${uuidv4()}${ext ? `.${ext}` : ""}`;
  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: objectKey,
    ContentType: contentType,
    ContentLength: contentLength,
  });
  // `Content-Length` is signed by the presigner by default, so S3 enforces the
  // exact capped size — the client must send exactly these many bytes or the
  // signature won't match. (A `signableHeaders: new Set(["content-length"])`
  // option was removed: it is redundant here since content-length is already in
  // the default signed-header set, verified as `content-length;host` either way.)
  const uploadUrl = await getSignedUrl(client, command, {
    expiresIn: 3600,
  });
  return { objectKey, uploadUrl };
}

export interface BuildObjectHead {
  contentLength: number;
  contentType: string | null;
}

/** Authoritative size + content-type for an uploaded object. Throws AppError 400
 *  when the key is missing — the submit path uses this to fail fast on
 *  unfetchable references. */
export async function headBuildObject(
  objectKey: string,
): Promise<BuildObjectHead> {
  assertBuildKey(objectKey);
  const { bucket, client } = requireBucket();
  try {
    const res = await client.send(
      new HeadObjectCommand({ Bucket: bucket, Key: objectKey }),
    );
    if (res.ContentLength == null) {
      throw new AppError(400, `Attachment size unavailable: ${objectKey}`);
    }
    return {
      contentLength: res.ContentLength,
      contentType: res.ContentType ?? null,
    };
  } catch (err) {
    if (isNotFound(err)) {
      throw new AppError(400, `Attachment not found: ${objectKey}`);
    }
    throw err;
  }
}

/** Read an uploaded object's bytes. Used by the executor (off the request path)
 *  to build LLM content + run moderation. Throws AppError 400 on a missing key. */
export async function getBuildObjectBytes(
  objectKey: string,
): Promise<Uint8Array> {
  assertBuildKey(objectKey);
  const { bucket, client } = requireBucket();
  try {
    const res = await client.send(
      new GetObjectCommand({ Bucket: bucket, Key: objectKey }),
    );
    if (!res.Body) {
      throw new AppError(400, `Attachment has no body: ${objectKey}`);
    }
    return await res.Body.transformToByteArray();
  } catch (err) {
    if (err instanceof AppError) throw err;
    if (isNotFound(err)) {
      throw new AppError(400, `Attachment not found: ${objectKey}`);
    }
    throw err;
  }
}

/** The private bucket name, for callers that reference objects by S3 ref
 *  (e.g. Rekognition's `S3Object`) rather than fetching bytes. */
export function getPrivateBucket(): string {
  return requireBucket().bucket;
}
