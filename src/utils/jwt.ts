import * as jose from "jose";
import { AppError } from "@/utils/errors";
import { tryCatch } from "@/utils/try-catch";
import logger from "./logger";

export type JWTPayload = {
  inboxId: string;
  xmtpInstallationId: string;
};

export const createJwtToken = async (args: {
  inboxId: string;
  xmtpInstallationId: string;
}) => {
  if (!process.env.JWT_SECRET) {
    throw new AppError(500, "JWT_SECRET is not set");
  }
  // Create JWT token
  const { data: jwt, error: jwtError } = await tryCatch(
    new jose.SignJWT({
      inboxId: args.inboxId,
      xmtpInstallationId: args.xmtpInstallationId,
    } satisfies JWTPayload)
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode(process.env.JWT_SECRET)),
  );

  if (jwtError) {
    logger.error(jwtError);
    throw new AppError(500, "Failed to create JWT token", jwtError);
  }

  return jwt;
};
