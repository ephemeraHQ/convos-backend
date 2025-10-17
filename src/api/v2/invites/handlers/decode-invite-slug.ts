import { createHash } from "crypto";
import { fromBinary, toBinary } from "@bufbuild/protobuf";
import { timestampDate } from "@bufbuild/protobuf/wkt";
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
  | "conversationExpiresAt"
  | "expiresAt"
  | "expiresAfterUse"
>;

// Maximum slug length to prevent DoS (browser URL limit is ~2048 chars)
// Reserve some space for the rest of the URL path
const MAX_SLUG_LENGTH = 2048;

function base64URLDecode(slug: string): Uint8Array {
  if (slug.length > MAX_SLUG_LENGTH) {
    throw new Error("Slug too large");
  }

  let base64 = slug.replace(/-/g, "+").replace(/_/g, "/");

  while (base64.length % 4 !== 0) {
    base64 += "=";
  }

  const buffer = Buffer.from(base64, "base64");
  return new Uint8Array(buffer);
}

function sha256(data: Uint8Array): Buffer {
  return createHash("sha256").update(data).digest();
}

function recoverPublicKey(signedInvite: SignedInvite) {
  const payload = signedInvite.payload;
  if (!payload) {
    throw new Error("Missing payload");
  }

  const signature = signedInvite.signature;
  if (signature.length !== 65) {
    throw new Error("Invalid signature length");
  }

  const signatureData = signature.slice(0, 64);
  const recoveryId = signature[64];

  const payloadBytes = toBinary(InvitePayloadSchema, payload);
  const messageHash = sha256(payloadBytes);

  const publicKey = secp256k1.ecdsaRecover(
    signatureData,
    recoveryId,
    messageHash,
    false,
  );

  return Buffer.from(publicKey);
}

function decodeInviteSlug(slug: string): DecodedInvite {
  try {
    const data = base64URLDecode(slug);

    const signedInvite = fromBinary(SignedInviteSchema, data);
    const payload = signedInvite.payload;

    if (!payload) {
      throw new Error("Missing payload in signed invite");
    }

    recoverPublicKey(signedInvite);

    return {
      conversationToken: payload.conversationToken,
      creatorInboxId: payload.creatorInboxId,
      tag: payload.tag,
      name: payload.name,
      description: payload.description,
      imageURL: payload.imageURL,
      conversationExpiresAt: payload.conversationExpiresAt,
      expiresAt: payload.expiresAt,
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
        conversationExpiresAt: decoded.conversationExpiresAt
          ? timestampDate(decoded.conversationExpiresAt).toISOString()
          : null,
        expiresAt: decoded.expiresAt
          ? timestampDate(decoded.expiresAt).toISOString()
          : null,
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
