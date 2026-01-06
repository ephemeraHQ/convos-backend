import { beforeAll, describe, expect, test } from "bun:test";
import * as jose from "jose";
import { JWT_ISSUER } from "@/config";
import { AppError } from "@/utils/errors";
import {
  createTestJwtWithPayload,
  createV2JwtToken,
  validateJWTKeys,
  verifyV2JwtToken,
} from "@/utils/v2/jwt";

// JWT tests keys are set in tests/preload.ts before config.ts loads

beforeAll(async () => {
  await validateJWTKeys();
});

describe("verifyV2JwtToken", () => {
  test("should verify a valid token and return payload", async () => {
    const deviceId = "test-device-123";
    const token = await createV2JwtToken({ deviceId });

    const payload = await verifyV2JwtToken({ token });

    expect(payload.deviceId).toBe(deviceId);
  });

  test("should verify token with metadata", async () => {
    const deviceId = "test-device-456";
    const metadata = { notificationExtensionOnly: true };
    const token = await createV2JwtToken({ deviceId, metadata });

    const payload = await verifyV2JwtToken({ token });

    expect(payload.deviceId).toBe(deviceId);
    expect(payload.metadata?.notificationExtensionOnly).toBe(true);
  });

  test("should throw 'Token expired' for expired tokens", async () => {
    const deviceId = "test-device-expired";
    // Create token that expires immediately
    const token = await createV2JwtToken({
      deviceId,
      expirationTime: "0s",
    });

    // Small delay to ensure token is expired
    await new Promise((resolve) => setTimeout(resolve, 10));

    try {
      await verifyV2JwtToken({ token });
      expect.unreachable("Should have thrown an error");
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      const appError = error as AppError;
      expect(appError.statusCode).toBe(401);
      expect(appError.message).toBe("Token expired");
      // Verify no implementation details are leaked
      expect(appError.details).toBeUndefined();
    }
  });

  test("should throw 'Invalid token' for tampered signature", async () => {
    const deviceId = "test-device-tampered";
    const token = await createV2JwtToken({ deviceId });

    // Tamper with the signature (last part of JWT)
    const parts = token.split(".");
    parts[2] = parts[2].slice(0, -5) + "XXXXX";
    const tamperedToken = parts.join(".");

    try {
      await verifyV2JwtToken({ token: tamperedToken });
      expect.unreachable("Should have thrown an error");
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      const appError = error as AppError;
      expect(appError.statusCode).toBe(401);
      expect(appError.message).toBe("Invalid token");
      expect(appError.details).toBeUndefined();
    }
  });

  test("should throw 'Invalid token' for wrong signing key", async () => {
    // Create a token signed with a different key
    const differentKeyPair = await jose.generateKeyPair("ES256");
    const token = await new jose.SignJWT({ deviceId: "test-device" })
      .setProtectedHeader({ alg: "ES256" })
      .setSubject("test-device")
      .setIssuer(JWT_ISSUER)
      .setIssuedAt()
      .setExpirationTime("15m")
      .sign(differentKeyPair.privateKey);

    try {
      await verifyV2JwtToken({ token });
      expect.unreachable("Should have thrown an error");
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      const appError = error as AppError;
      expect(appError.statusCode).toBe(401);
      expect(appError.message).toBe("Invalid token");
      expect(appError.details).toBeUndefined();
    }
  });

  test("should throw 'Invalid payload structure' for missing deviceId", async () => {
    // Create a valid JWT but with wrong payload structure (missing deviceId)
    const token = await createTestJwtWithPayload({
      payload: { wrongField: "value" },
    });

    try {
      await verifyV2JwtToken({ token });
      expect.unreachable("Should have thrown an error");
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      const appError = error as AppError;
      expect(appError.statusCode).toBe(401);
      expect(appError.message).toBe("Invalid payload structure");
      expect(appError.details).toBeUndefined();
    }
  });

  test("should throw 'Invalid token' for malformed JWT", async () => {
    try {
      await verifyV2JwtToken({ token: "not-a-valid-jwt" });
      expect.unreachable("Should have thrown an error");
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      const appError = error as AppError;
      expect(appError.statusCode).toBe(401);
      expect(appError.message).toBe("Invalid token");
      expect(appError.details).toBeUndefined();
    }
  });
});

describe("createV2JwtToken", () => {
  test("should create a valid token", async () => {
    const deviceId = "test-device-create";
    const token = await createV2JwtToken({ deviceId });

    expect(token).toBeDefined();
    expect(typeof token).toBe("string");
    expect(token.split(".")).toHaveLength(3);
  });

  test("should include metadata in token", async () => {
    const deviceId = "test-device-metadata";
    const metadata = { notificationExtensionOnly: true };
    const token = await createV2JwtToken({ deviceId, metadata });

    // Decode and verify payload contains metadata
    const payload = await verifyV2JwtToken({ token });
    expect(payload.metadata).toEqual(metadata);
  });

  test("should respect custom expiration time", async () => {
    const deviceId = "test-device-expiry";
    const token = await createV2JwtToken({
      deviceId,
      expirationTime: "1h",
    });

    // Decode token to check expiration
    const decoded = jose.decodeJwt(token);
    const now = Math.floor(Date.now() / 1000);
    const expectedExp = now + 3600; // 1 hour

    // Allow 5 second tolerance
    expect(decoded.exp).toBeGreaterThan(expectedExp - 5);
    expect(decoded.exp).toBeLessThan(expectedExp + 5);
  });
});
