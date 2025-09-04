import * as jose from "jose";
import { AppError } from "@/utils/errors";
import { tryCatch } from "@/utils/try-catch";
import logger from "./logger";

export type JWTMetadata = {
  notificationExtensionOnly?: boolean;
};

export type JWTPayload = {
  inboxId: string;
  xmtpInstallationId: string;
  metadata?: JWTMetadata;
};

export const createJwtToken = async (args: {
  inboxId: string;
  xmtpInstallationId: string;
  metadata?: JWTMetadata;
  expirationTime?: string;
}) => {
  if (!process.env.JWT_SECRET) {
    throw new AppError(500, "JWT_SECRET is not set");
  }

  const payload: JWTPayload = {
    inboxId: args.inboxId,
    xmtpInstallationId: args.xmtpInstallationId,
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
      .setExpirationTime(args.expirationTime ?? "1h")
      .sign(new TextEncoder().encode(process.env.JWT_SECRET)),
  );

  if (jwtError) {
    logger.error(jwtError);
    throw new AppError(500, "Failed to create JWT token", jwtError);
  }

  return jwt;
};

export const verifyJwtToken = async (args: { token: string }) => {
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
    logger.error("JWT verification failed", verifyError);
    throw new AppError(401, "Invalid or expired token", verifyError);
  }

  return verified.payload as JWTPayload;
};

export const isNotificationExtensionOnlyToken = (payload: JWTPayload) => {
  return payload.metadata?.notificationExtensionOnly === true;
};
