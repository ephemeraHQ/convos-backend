import * as jose from "jose";
import { z } from "zod";
import { JWT_ISSUER, JWT_PRIVATE_KEY, JWT_PUBLIC_KEY } from "@/config";
import { AppError } from "@/utils/errors";
import logger from "@/utils/logger";
import { tryCatch } from "@/utils/try-catch";

// Maximum size in bytes for JWT metadata to prevent token bloat
const MAX_JWT_METADATA_SIZE = 1024;

export type v2JWTMetadata = {
  notificationExtensionOnly?: boolean;
};

export type V2JWTPayload = {
  deviceId: string;
  metadata?: v2JWTMetadata;
};

const v2JWTPayloadSchema = z.object({
  deviceId: z.string(),
  metadata: z
    .object({
      notificationExtensionOnly: z.boolean().optional(),
    })
    .optional(),
});

let privateKeyPromise: Promise<jose.KeyLike> | null = null;
let publicKeyPromise: Promise<jose.KeyLike> | null = null;

/**
 * Lazy-load and cache the private key.
 * Caches the promise to prevent concurrent imports.
 */
const loadPrivateKey = (): Promise<jose.KeyLike> => {
  if (!privateKeyPromise) {
    if (!JWT_PRIVATE_KEY || JWT_PRIVATE_KEY.trim().length === 0) {
      return Promise.reject(
        new Error(
          "JWT_PRIVATE_KEY is not configured - set a valid PEM-encoded ECDSA P-256 private key",
        ),
      );
    }
    privateKeyPromise = jose.importPKCS8(JWT_PRIVATE_KEY, "ES256");
  }
  return privateKeyPromise;
};

/**
 * Lazy-load and cache the public key.
 * Caches the promise to prevent concurrent imports.
 */
const loadPublicKey = (): Promise<jose.KeyLike> => {
  if (!publicKeyPromise) {
    if (!JWT_PUBLIC_KEY || JWT_PUBLIC_KEY.trim().length === 0) {
      return Promise.reject(
        new Error(
          "JWT_PUBLIC_KEY is not configured - set a valid PEM-encoded ECDSA P-256 public key",
        ),
      );
    }
    publicKeyPromise = jose.importSPKI(JWT_PUBLIC_KEY, "ES256");
  }
  return publicKeyPromise;
};

/**
 * Validate JWT keys at application startup and cache them.
 * Performs a test sign/verify to ensure the key pair is valid and matches.
 */
export const validateJWTKeys = async () => {
  try {
    await loadPrivateKey();
    logger.info("JWT private key loaded");
  } catch (error) {
    logger.error({ error }, "Invalid JWT_PRIVATE_KEY format");
    throw new Error(
      "Invalid JWT_PRIVATE_KEY: must be a valid PEM-encoded ECDSA P-256 private key",
    );
  }

  try {
    await loadPublicKey();
    logger.info("JWT public key loaded");
  } catch (error) {
    logger.error({ error }, "Invalid JWT_PUBLIC_KEY format");
    throw new Error(
      "Invalid JWT_PUBLIC_KEY: must be a valid PEM-encoded ECDSA P-256 public key",
    );
  }

  // Verify the key pair works together by signing and verifying a test token
  try {
    const testToken = await createJwtToken({ deviceId: "startup-validation" });
    await verifyJwtToken({ token: testToken });
    logger.info("JWT key pair validation successful");
  } catch (error) {
    logger.error({ error }, "JWT key pair mismatch");
    throw new Error(
      "JWT key pair validation failed: private and public keys do not match",
    );
  }
};

export const createJwtToken = async (args: {
  deviceId: string;
  metadata?: v2JWTMetadata;
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

  // Get cached ECDSA private key
  const { data: privateKey, error: importError } =
    await tryCatch(loadPrivateKey());

  if (importError) {
    logger.error({ error: importError }, "Failed to load JWT private key");
    throw new AppError(500, "Failed to load JWT private key", importError);
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
    logger.error({ error: jwtError }, "Failed to create JWT token");
    throw new AppError(500, "Failed to create JWT token", jwtError);
  }

  return jwt;
};

export const verifyJwtToken = async (args: { token: string }) => {
  // Get cached ECDSA public key for verification
  const { data: publicKey, error: importError } =
    await tryCatch(loadPublicKey());

  if (importError) {
    logger.error(
      { error: importError },
      "Failed to load JWT public key for verification",
    );
    throw new AppError(500, "Failed to load JWT public key", importError);
  }

  // Verify JWT token using the public key
  const { data: verified, error: verifyError } = await tryCatch(
    jose.jwtVerify(args.token, publicKey, {
      issuer: JWT_ISSUER,
      algorithms: ["ES256"],
    }),
  );

  if (verifyError) {
    if (verifyError instanceof jose.errors.JWTExpired) {
      logger.info({ error: verifyError }, "JWT token expired");
      throw new AppError(401, "Token expired");
    }

    logger.warn(
      { error: verifyError },
      "JWT verification failed: Invalid token",
    );
    throw new AppError(401, "Invalid token");
  }

  const parseResult = v2JWTPayloadSchema.safeParse(verified.payload);
  if (!parseResult.success) {
    logger.error(
      { error: parseResult.error },
      "JWT verification failed: Invalid payload structure",
    );
    throw new AppError(401, "Invalid payload structure");
  }

  return parseResult.data;
};

export const isNotificationExtensionOnlyToken = (payload: V2JWTPayload) => {
  return payload.metadata?.notificationExtensionOnly === true;
};

/**
 * Create a JWT with a custom payload - This is for testing only
 * Allows testing invalid payload structures
 */
export const createTestJwtWithPayload = async (args: {
  payload: Record<string, unknown>;
  expirationTime?: string;
}) => {
  const privateKey = await loadPrivateKey();

  return new jose.SignJWT(args.payload)
    .setProtectedHeader({ alg: "ES256" })
    .setSubject("test")
    .setIssuer(JWT_ISSUER)
    .setIssuedAt()
    .setExpirationTime(args.expirationTime ?? "15m")
    .sign(privateKey);
};
