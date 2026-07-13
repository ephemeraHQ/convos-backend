/**
 * Attachment resolver — turn persisted `{ objectKey, mimeType, filename? }`
 * references into LLM-ready content, off the request path.
 *
 * For each attachment: fetch the bytes from the private bucket, re-check
 * size/type (defense-in-depth over the submit-time caps), then:
 *   - image → moderate (Rekognition) + emit an `image` data-URI block,
 *   - pdf   → emit a `pdf` data-URI block,
 *   - text  → decode UTF-8 + moderate + emit an inline `text` block,
 *   - audio → transcribe to text + moderate the transcript.
 *
 * Images/PDFs/text files come back as `ResolvedAttachment`s; audio comes back as
 * `transcripts` the caller folds into the generation's text. Shared by the
 * async executor (moderate: true) and the admin ephemeral endpoint
 * (moderate: false — the caller is trusted and nothing is persisted).
 */

import { z } from "zod";
import {
  BUILD_ATTACHMENTS_MAX_COUNT,
  BUILD_ATTACHMENTS_MAX_TOTAL_BYTES,
} from "@/config";
import { AppError } from "@/utils/errors";
import {
  classifyMime,
  decodeTextAttachment,
  getBuildObjectBytes,
  maxBytesForKind,
  normalizeMime,
} from "./build-attachments";
import { checkImage } from "./image-moderation";
import { checkContent } from "./moderation";
import { type TraceContext } from "./openrouter-client";
import type { ResolvedAttachment } from "./templateGen";
import { transcribeAudio } from "./transcribe";

/** Wire schema for one attachment reference. Shared by the generation and
 *  ephemeral handlers so both validate the array identically. */
export const attachmentRefSchema = z
  .object({
    objectKey: z.string().min(1).max(512),
    mimeType: z.string().min(1).max(255),
    filename: z.string().max(255).optional(),
  })
  .strict();

export type AttachmentRef = z.infer<typeof attachmentRefSchema>;

/** The whole `attachments` field: an optional array capped at the per-
 *  generation count, with object keys required to be unique. */
export const attachmentsArraySchema = z
  .array(attachmentRefSchema)
  .max(BUILD_ATTACHMENTS_MAX_COUNT, {
    message: `At most ${BUILD_ATTACHMENTS_MAX_COUNT} attachments allowed`,
  })
  .refine((arr) => new Set(arr.map((a) => a.objectKey)).size === arr.length, {
    message: "Duplicate attachment objectKey",
  })
  .optional();

/** Thrown when an attachment is rejected by moderation. Carried distinctly so
 *  the async executor can mark the generation `failed` with the reason. */
export class AttachmentModerationError extends Error {
  constructor(
    public reason: string,
    public objectKey: string,
  ) {
    super(`Attachment blocked by moderation: ${reason}`);
    this.name = "AttachmentModerationError";
  }
}

export interface ResolvedInputs {
  /** Image + PDF content blocks for the generator. */
  attachments: ResolvedAttachment[];
  /** Audio transcripts, in attachment order — the caller folds these into the
   *  generation's text input. */
  transcripts: string[];
}

export interface ResolveOpts {
  signal?: AbortSignal;
  trace?: TraceContext;
  /** Run binary moderation (Rekognition on images, text check on transcripts).
   *  False on the trusted admin path. */
  moderate: boolean;
}

type OneResult = { byteLength: number } & (
  | { kind: "attachment"; attachment: ResolvedAttachment }
  | { kind: "transcript"; transcript: string }
);

async function resolveOne(
  ref: AttachmentRef,
  opts: ResolveOpts,
): Promise<OneResult> {
  const kind = classifyMime(ref.mimeType);
  if (!kind) {
    throw new AppError(400, `Unsupported attachment type: ${ref.mimeType}`);
  }

  const bytes = await getBuildObjectBytes(ref.objectKey);
  if (bytes.length > maxBytesForKind(kind)) {
    throw new AppError(
      400,
      `Attachment ${ref.objectKey} exceeds the ${kind} size limit`,
    );
  }

  if (kind === "audio") {
    const transcript = await transcribeAudio(
      bytes,
      ref.mimeType,
      opts.signal,
      opts.trace,
    );
    if (opts.moderate) {
      const verdict = await checkContent(transcript, opts.trace);
      if (!verdict.allowed) {
        throw new AttachmentModerationError(
          verdict.reason ?? "blocked",
          ref.objectKey,
        );
      }
    }
    return { kind: "transcript", transcript, byteLength: bytes.length };
  }

  if (kind === "text") {
    const filename = ref.filename || "attachment.txt";
    const text = decodeTextAttachment(bytes, filename);
    // A text attachment is user-supplied prose heading straight for the prompt,
    // so it gets the same content check the typed directive and voice transcripts
    // get. Images go to Rekognition; PDFs are the one kind whose contents still
    // reach the model unchecked.
    if (opts.moderate) {
      const verdict = await checkContent(text, opts.trace);
      if (!verdict.allowed) {
        throw new AttachmentModerationError(
          verdict.reason ?? "blocked",
          ref.objectKey,
        );
      }
    }
    return {
      kind: "attachment",
      byteLength: bytes.length,
      attachment: { kind: "text", filename, text },
    };
  }

  if (kind === "image" && opts.moderate) {
    const verdict = await checkImage(ref.objectKey);
    if (!verdict.allowed) {
      throw new AttachmentModerationError(
        verdict.reason ?? "blocked",
        ref.objectKey,
      );
    }
  }

  const base64 = Buffer.from(bytes).toString("base64");
  if (kind === "image") {
    const mime = normalizeMime(ref.mimeType);
    return {
      kind: "attachment",
      byteLength: bytes.length,
      attachment: {
        kind: "image",
        mimeType: mime,
        dataUri: `data:${mime};base64,${base64}`,
      },
    };
  }
  return {
    kind: "attachment",
    byteLength: bytes.length,
    attachment: {
      kind: "pdf",
      filename: ref.filename || "document.pdf",
      dataUri: `data:application/pdf;base64,${base64}`,
    },
  };
}

// ---------------------------------------------------------------------------
// Test seam — singleton override (mirrors the other service seams)
// ---------------------------------------------------------------------------

export type AttachmentResolverOverride = (
  refs: AttachmentRef[],
  opts: ResolveOpts,
) => Promise<ResolvedInputs>;

let _override: AttachmentResolverOverride | null = null;

/** Install a test override for `resolveAttachments`. Pass `null` to restore. */
export function __resetAttachmentResolverForTests(
  override: AttachmentResolverOverride | null,
): void {
  _override = override;
}

/** Resolve every attachment in parallel. Rejects on the first unfetchable /
 *  oversize / unsupported / moderation-blocked attachment. */
export async function resolveAttachments(
  refs: AttachmentRef[],
  opts: ResolveOpts,
): Promise<ResolvedInputs> {
  if (_override) return _override(refs, opts);
  const results = await Promise.all(refs.map((ref) => resolveOne(ref, opts)));
  // Defense-in-depth: re-check the aggregate byte size executor-side. The submit
  // path already enforces this against HeadObject sizes; this guards against a
  // content-swap between submit and resolve and keeps the per-file check above.
  const totalBytes = results.reduce((sum, r) => sum + r.byteLength, 0);
  if (totalBytes > BUILD_ATTACHMENTS_MAX_TOTAL_BYTES) {
    throw new AppError(
      400,
      `Attachments exceed the total size limit of ${BUILD_ATTACHMENTS_MAX_TOTAL_BYTES} bytes`,
    );
  }
  const attachments: ResolvedAttachment[] = [];
  const transcripts: string[] = [];
  for (const r of results) {
    if (r.kind === "attachment") attachments.push(r.attachment);
    else transcripts.push(r.transcript);
  }
  return { attachments, transcripts };
}
