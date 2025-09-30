import { createHash } from "crypto";
import { fromBinary, toBinary } from "@bufbuild/protobuf";
import type { Request, Response } from "express";
import * as secp256k1 from "secp256k1";
import { z } from "zod";
import {
  InvitePayloadSchema,
  SignedInviteSchema,
  type SignedInvite,
} from "@/gen/invite/v2/invite_pb";

const paramsSchema = z.object({
  slug: z.string().min(1, "Slug is required"),
});

type DecodeInviteSlugParams = z.infer<typeof paramsSchema>;

type DecodedInvite = {
  encryptedCode: string;
  creatorInboxId: string;
  tag: string;
  signerPublicKey: string;
  isSignatureValid: boolean;
};

function base64URLDecode(slug: string): Uint8Array {
  let base64 = slug.replace(/-/g, "+").replace(/_/g, "/");

  while (base64.length % 4 !== 0) {
    base64 += "=";
  }

  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes;
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

    let isValid = false;
    let publicKey = "";

    try {
      const recoveredKey = recoverPublicKey(signedInvite);
      publicKey = recoveredKey.toString("hex");
      isValid = true;
    } catch {
      isValid = false;
    }

    return {
      encryptedCode: payload.code,
      creatorInboxId: payload.creatorInboxId,
      tag: payload.tag,
      signerPublicKey: publicKey,
      isSignatureValid: isValid,
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
    encryptedCode: string;
    creatorInboxId: string;
    tag: string;
    signerPublicKey: string;
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

    if (!decoded.isSignatureValid) {
      res.status(400).json({
        success: false,
        error: "INVALID_SIGNATURE",
        message: "Invite signature is invalid",
      });
      return;
    }

    const response: DecodeInviteSlugResponse = {
      success: true,
      data: {
        encryptedCode: decoded.encryptedCode,
        creatorInboxId: decoded.creatorInboxId,
        tag: decoded.tag,
        signerPublicKey: decoded.signerPublicKey,
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
