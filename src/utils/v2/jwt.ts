import * as jose from "jose";
import { MAX_JWT_METADATA_SIZE } from "@/api/shared/notifications/constants";
import { JWT_SECRET_BYTES } from "@/config";
import { AppError } from "@/utils/errors";
import logger from "@/utils/logger";
import { tryCatch } from "@/utils/try-catch";

export type V2JWTMetadata = {
  notificationExtensionOnly?: boolean;
  gatewayAuthorized?: boolean;
};

export type V2JWTPayload = {
  clientIdentifier: string;
  deviceId: string;
  metadata?: V2JWTMetadata;
};

export const createV2JwtToken = async (args: {
  clientIdentifier: string;
  deviceId: string;
  metadata?: V2JWTMetadata;
  expirationTime?: string;
}) => {
  // Validate metadata size to prevent JWT bloat
  if (args.metadata) {
    const metadataSize = JSON.stringify(args.metadata).length;
    if (metadataSize > MAX_JWT_METADATA_SIZE) {
      throw new AppError(
        400,
        `JWT metadata exceeds maximum size of ${MAX_JWT_METADATA_SIZE} bytes`,
      );
    }
  }

  const payload: V2JWTPayload = {
    clientIdentifier: args.clientIdentifier,
    deviceId: args.deviceId,
  };

  // Add metadata if provided
  if (args.metadata) {
    payload.metadata = args.metadata;
  }

  // Create JWT token
  const { data: jwt, error: jwtError } = await tryCatch(
    new jose.SignJWT(payload)
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime(args.expirationTime ?? "15m")
      .sign(JWT_SECRET_BYTES),
  );

  if (jwtError) {
    logger.error(jwtError);
    throw new AppError(500, "Failed to create JWT token", jwtError);
  }

  return jwt;
};

export const verifyV2JwtToken = async (args: { token: string }) => {
  const { data: verified, error: verifyError } = await tryCatch(
    jose.jwtVerify(args.token, JWT_SECRET_BYTES),
  );

  if (verifyError) {
    logger.error("V2 JWT verification failed", verifyError);
    throw new AppError(401, "Invalid or expired token", verifyError);
  }

  return verified.payload as V2JWTPayload;
};

export const isNotificationExtensionOnlyToken = (payload: V2JWTPayload) => {
  return payload.metadata?.notificationExtensionOnly === true;
};
