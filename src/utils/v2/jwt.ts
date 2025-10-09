import * as jose from "jose";
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
  if (!process.env.JWT_SECRET) {
    throw new AppError(500, "JWT_SECRET is not set");
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
      .sign(new TextEncoder().encode(process.env.JWT_SECRET)),
  );

  if (jwtError) {
    logger.error(jwtError);
    throw new AppError(500, "Failed to create JWT token", jwtError);
  }

  return jwt;
};

export const verifyV2JwtToken = async (args: { token: string }) => {
  if (!process.env.JWT_SECRET) {
    throw new AppError(500, "JWT_SECRET is not set");
  }

  const { data: verified, error: verifyError } = await tryCatch(
    jose.jwtVerify(
      args.token,
      new TextEncoder().encode(process.env.JWT_SECRET),
    ),
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
