import * as jose from "jose";
import { z } from "zod";
import { MAX_JWT_METADATA_SIZE } from "@/api/shared/notifications/constants";
import { JWT_ISSUER, JWT_PRIVATE_KEY, JWT_PUBLIC_KEY } from "@/config";
import { AppError } from "@/utils/errors";
import logger from "@/utils/logger";
import { tryCatch } from "@/utils/try-catch";

export type V2JWTMetadata = {
  notificationExtensionOnly?: boolean;
};

export type V2JWTPayload = {
  deviceId: string;
  metadata?: V2JWTMetadata;
};

const v2JWTPayloadSchema = z.object({
  deviceId: z.string(),
  metadata: z
    .object({
      notificationExtensionOnly: z.boolean().optional(),
    })
    .optional(),
});

export const createV2JwtToken = async (args: {
  deviceId: string;
  metadata?: V2JWTMetadata;
  expirationTime?: string;
}) => {
  // Validate metadata size to prevent JWT bloat
  if (args.metadata) {
    const metadataSize = new TextEncoder().encode(
      JSON.stringify(args.metadata),
    ).length;
    if (metadataSize > MAX_JWT_METADATA_SIZE) {
      throw new AppError(
        400,
        `JWT metadata exceeds maximum size of ${MAX_JWT_METADATA_SIZE} bytes`,
      );
    }
  }

  const payload: V2JWTPayload = {
    deviceId: args.deviceId,
  };

  // Add metadata if provided
  if (args.metadata) {
    payload.metadata = args.metadata;
  }

  // Import ECDSA private key
  const { data: privateKey, error: importError } = await tryCatch(
    jose.importPKCS8(JWT_PRIVATE_KEY, "ES256"),
  );

  if (importError) {
    logger.error("Failed to import JWT private key", importError);
    throw new AppError(500, "Failed to import JWT private key", importError);
  }

  // Create JWT token with ECDSA ES256
  const { data: jwt, error: jwtError } = await tryCatch(
    new jose.SignJWT(payload)
      .setProtectedHeader({ alg: "ES256" })
      .setSubject(args.deviceId) // Standard 'sub' claim for gateway
      .setIssuer(JWT_ISSUER) // Standard 'iss' claim
      .setIssuedAt()
      .setExpirationTime(args.expirationTime ?? "15m")
      .sign(privateKey),
  );

  if (jwtError) {
    logger.error("Failed to create JWT token", jwtError);
    throw new AppError(500, "Failed to create JWT token", jwtError);
  }

  return jwt;
};

export const verifyV2JwtToken = async (args: { token: string }) => {
  // Import ECDSA public key for verification
  const { data: publicKey, error: importError } = await tryCatch(
    jose.importSPKI(JWT_PUBLIC_KEY, "ES256"),
  );

  if (importError) {
    logger.error(
      "Failed to import JWT public key for verification",
      importError,
    );
    throw new AppError(500, "Failed to import JWT public key", importError);
  }

  // Verify JWT token using the public key
  const { data: verified, error: verifyError } = await tryCatch(
    jose.jwtVerify(args.token, publicKey, {
      issuer: JWT_ISSUER,
    }),
  );

  if (verifyError) {
    logger.error("V2 JWT verification failed", verifyError);
    throw new AppError(401, "Invalid or expired token", verifyError);
  }

  const parseResult = v2JWTPayloadSchema.safeParse(verified.payload);
  if (!parseResult.success) {
    logger.error("Invalid JWT payload structure", parseResult.error);
    throw new AppError(401, "Invalid JWT payload structure");
  }

  return parseResult.data;
};

export const isNotificationExtensionOnlyToken = (payload: V2JWTPayload) => {
  return payload.metadata?.notificationExtensionOnly === true;
};
