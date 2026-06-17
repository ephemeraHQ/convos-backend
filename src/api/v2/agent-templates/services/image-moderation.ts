/**
 * Image moderation — AWS Rekognition content safety for generation attachments.
 *
 * Runs off the request path (in the executor's resolve stage), not at submit:
 * Rekognition over N images is too slow to block the POST, so an unsafe image
 * produces a terminal `failed` generation rather than a synchronous 422. Mirrors
 * the text `moderation.ts` contract — same `ModerationResult` shape, same
 * **fail-open** posture (any Rekognition error → `{ allowed: true }`), same
 * singleton test seam.
 *
 * Reads the object by S3 reference (`Image.S3Object`) so it never downloads the
 * bytes itself and isn't bound by Rekognition's 5 MB raw-`Bytes` limit. The
 * bucket must be in the same region as the Rekognition client.
 *
 * Only PNG/JPEG reach here — the attachment allowlist (build-attachments.ts)
 * already excludes formats Rekognition can't read.
 */

import {
  DetectModerationLabelsCommand,
  RekognitionClient,
} from "@aws-sdk/client-rekognition";
import type { ModerationResult } from "@/api/v2/agent-templates/services/moderation";
import { IMAGE_MODERATION_MIN_CONFIDENCE } from "@/config";
import logger from "@/utils/logger";
import { getPrivateBucket } from "./build-attachments";

// Ambient credentials/region, like the S3 client.
const rekognitionClient = new RekognitionClient({});

// ---------------------------------------------------------------------------
// Test seam — singleton override (mirrors moderation.ts)
// ---------------------------------------------------------------------------

export type ImageModerationOverride = (
  objectKey: string,
) => Promise<ModerationResult>;

let _override: ImageModerationOverride | null = null;

/** Install a test override for `checkImage`. Pass `null` to restore. */
export function __resetImageModerationForTests(
  override: ImageModerationOverride | null,
): void {
  _override = override;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Moderate one uploaded image by object key. Returns `{ allowed: false,
 * reason }` when Rekognition flags it, `{ allowed: true }` otherwise — and ALSO
 * `{ allowed: true }` on any infrastructure error (fail-open).
 */
export async function checkImage(objectKey: string): Promise<ModerationResult> {
  if (_override) {
    return _override(objectKey);
  }
  return _checkImage(objectKey);
}

async function _checkImage(objectKey: string): Promise<ModerationResult> {
  let bucket: string;
  try {
    bucket = getPrivateBucket();
  } catch {
    // Bucket unconfigured — nothing to moderate against; fail open.
    return { allowed: true };
  }

  try {
    const res = await rekognitionClient.send(
      new DetectModerationLabelsCommand({
        Image: { S3Object: { Bucket: bucket, Name: objectKey } },
        MinConfidence: IMAGE_MODERATION_MIN_CONFIDENCE,
      }),
    );
    const labels = res.ModerationLabels ?? [];
    if (labels.length === 0) {
      return { allowed: true };
    }
    // Prefer the top-level category (ParentName) when present, else the label
    // name, as the human-readable block reason.
    const top = labels[0];
    const reason = top.ParentName?.trim() || top.Name?.trim() || "blocked";
    return { allowed: false, reason };
  } catch (err) {
    logger.warn(
      { err, objectKey },
      "[image-moderation] Rekognition failed, failing open",
    );
    return { allowed: true };
  }
}
