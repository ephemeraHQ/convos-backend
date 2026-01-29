import { createHash } from "crypto";
import { inflateRawSync } from "zlib";
import { fromBinary } from "@bufbuild/protobuf";
import type { Request, Response } from "express";
import * as secp256k1 from "secp256k1";
import { z } from "zod";
import {
  InvitePayloadSchema,
  SignedInviteSchema,
  type InvitePayload,
  type SignedInvite,
} from "@/gen/invite/v2/invite_pb";

const paramsSchema = z.object({
  slug: z.string().min(1, "Slug is required"),
});

type DecodeInviteSlugParams = z.infer<typeof paramsSchema>;

// Use pick to only include the fields we need and avoid typing errors
type DecodedInvite = Pick<
  InvitePayload,
  | "conversationToken"
  | "creatorInboxId"
  | "tag"
  | "name"
  | "description"
  | "imageURL"
  | "conversationExpiresAtUnix"
  | "expiresAtUnix"
  | "expiresAfterUse"
>;

// Maximum slug length to prevent DoS (browser URL limit is ~2048 chars)
// Reserve some space for the rest of the URL path
const MAX_SLUG_LENGTH = 2048;

// iOS compression format: [0x1F marker][4-byte BE size][raw DEFLATE data]
const COMPRESSION_MARKER = 0x1f;
const COMPRESSION_HEADER_SIZE = 5; // 1 byte marker + 4 bytes size
const MAX_DECOMPRESSED_SIZE = 64 * 1024; // 64KB - prevent decompression bombs

// Max valid Date in JS is 8.64e15 ms (±100 million days from epoch)
const MAX_DATE_MS = 8.64e15;

/**
 * Safely converts a Unix timestamp (seconds) to an ISO string.
 * Returns null for undefined, invalid, or out-of-range values.
 */
function unixSecondsToISOString(
  unixSeconds: bigint | undefined,
): string | null {
  if (unixSeconds === undefined) return null;
  const ms = Number(unixSeconds) * 1000;
  if (!Number.isFinite(ms) || Math.abs(ms) > MAX_DATE_MS) return null;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * Decompresses data if it has the iOS compression marker.
 * iOS format: [0x1F marker][4-byte BE original size][raw DEFLATE data]
 * Returns original data if not compressed.
 */
function maybeDecompress(data: Uint8Array): Uint8Array {
  if (data.length < COMPRESSION_HEADER_SIZE || data[0] !== COMPRESSION_MARKER) {
    return data;
  }

  // Read 4-byte big-endian original size (for validation)
  // Use >>> 0 to coerce to unsigned 32-bit (bitwise ops are signed in JS)
  const originalSize =
    ((data[1] << 24) | (data[2] << 16) | (data[3] << 8) | data[4]) >>> 0;

  // Validate size BEFORE decompression to prevent decompression bombs
  if (originalSize > MAX_DECOMPRESSED_SIZE) {
    throw new Error(
      `Decompressed size ${originalSize} exceeds maximum allowed ${MAX_DECOMPRESSED_SIZE}`,
    );
  }

  // Decompress the raw DEFLATE data (after 5-byte header)
  const compressedData = data.slice(COMPRESSION_HEADER_SIZE);
  const decompressed = inflateRawSync(Buffer.from(compressedData));

  // Validate decompressed size matches header
  if (decompressed.length !== originalSize) {
    throw new Error(
      `Decompressed size mismatch: expected ${originalSize}, got ${decompressed.length}`,
    );
  }

  return new Uint8Array(decompressed);
}

function base64URLDecode(slug: string): Uint8Array {
  if (slug.length > MAX_SLUG_LENGTH) {
    throw new Error("Slug too large");
  }

  // Remove "*" separators inserted for iMessage compatibility
  // as iMessage breaks URLs with Base64 sections longer than 301 characters
  // Convert URL-safe base64 back to standard base64 for Buffer.from()
  let base64 = slug.replace(/\*/g, "").replace(/-/g, "+").replace(/_/g, "/");

  while (base64.length % 4 !== 0) {
    base64 += "=";
  }

  const buffer = Buffer.from(base64, "base64");
  return new Uint8Array(buffer);
}

function sha256(data: Uint8Array): Buffer {
  return createHash("sha256").update(data).digest();
}

/**
 * Verifies that the signature is well-formed and recoverable.
 * This validates the cryptographic integrity of the invite.
 *
 * NOTE: This only verifies the signature is valid, not WHO signed it.
 * Identity verification of the signer happens client-side when joining.
 */
function verifySignature(signedInvite: SignedInvite): void {
  const payloadBytes = signedInvite.payload;
  if (payloadBytes.length === 0) {
    throw new Error("Missing payload");
  }

  const signature = signedInvite.signature;
  if (signature.length !== 65) {
    throw new Error("Invalid signature length");
  }

  const signatureData = signature.slice(0, 64);
  const recoveryId = signature[64];

  const messageHash = sha256(payloadBytes);

  // This will throw if the signature is invalid or unrecoverable
  secp256k1.ecdsaRecover(signatureData, recoveryId, messageHash, false);
}

/**
 * Decodes an invite slug into its payload components.
 *
 * NOTE: This endpoint is for UI preview purposes only (showing invite metadata before joining).
 * Signature validity is verified, but signer identity verification happens client-side.
 */
function decodeInviteSlug(slug: string): DecodedInvite {
  try {
    const data = base64URLDecode(slug);
    const decompressed = maybeDecompress(data);

    // Decode the SignedInvite wrapper
    const signedInvite = fromBinary(SignedInviteSchema, decompressed);
    const payloadBytes = signedInvite.payload;

    if (payloadBytes.length === 0) {
      throw new Error("Missing payload in signed invite");
    }

    // Verify the signature is valid (well-formed and recoverable)
    verifySignature(signedInvite);

    // Decode the InvitePayload from the payload bytes
    const payload = fromBinary(InvitePayloadSchema, payloadBytes);

    return {
      conversationToken: payload.conversationToken,
      creatorInboxId: payload.creatorInboxId,
      tag: payload.tag,
      name: payload.name,
      description: payload.description,
      imageURL: payload.imageURL,
      conversationExpiresAtUnix: payload.conversationExpiresAtUnix,
      expiresAtUnix: payload.expiresAtUnix,
      expiresAfterUse: payload.expiresAfterUse,
    };
  } catch (error) {
    throw new Error(
      `Failed to decode invite slug: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
  }
}

export type DecodeInviteSlugResponse = {
  success: boolean;
  data?: {
    name: string | null;
    description: string | null;
    imageURL: string | null;
    conversationExpiresAt: string | null;
    expiresAt: string | null;
    expiresAfterUse: boolean;
  };
  error?: string;
  message?: string;
};

export async function decodeInviteSlugHandler(
  req: Request<DecodeInviteSlugParams, unknown, unknown>,
  res: Response,
) {
  try {
    const { slug } = await paramsSchema.parseAsync(req.params);

    const decoded = decodeInviteSlug(slug);

    const response: DecodeInviteSlugResponse = {
      success: true,
      data: {
        name: decoded.name ?? null,
        description: decoded.description ?? null,
        imageURL: decoded.imageURL ?? null,
        conversationExpiresAt: unixSecondsToISOString(
          decoded.conversationExpiresAtUnix,
        ),
        expiresAt: unixSecondsToISOString(decoded.expiresAtUnix),
        expiresAfterUse: decoded.expiresAfterUse,
      },
    };

    res.status(200).json(response);
    return;
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({
        success: false,
        error: "INVALID_REQUEST",
        message: "Slug is required",
      });
      return;
    }

    if (error instanceof Error && error.message.includes("Slug too large")) {
      res.status(413).json({
        success: false,
        error: "SLUG_TOO_LARGE",
        message: "The invite link is too long",
      });
      return;
    }

    if (
      error instanceof Error &&
      error.message.includes("Failed to decode invite slug")
    ) {
      res.status(400).json({
        success: false,
        error: "INVALID_INVITE",
        message: "The invite link is invalid",
      });
      return;
    }

    req.log.error(
      { error, stack: error instanceof Error ? error.stack : undefined },
      "Invite decode error",
    );
    res.status(500).json({
      success: false,
      error: "INTERNAL_ERROR",
      message: "Failed to decode invite",
    });
    return;
  }
}
