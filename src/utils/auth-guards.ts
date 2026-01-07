import type { Request, Response } from "express";

/**
 * Verifies that the JWT token's deviceId matches the expected deviceId.
 * Sends an error response and returns false if verification fails.
 *
 * IMPORTANT: This guard fails closed - if jwtDeviceId is undefined, it rejects.
 * Only use on routes that require JWT authentication (authMiddleware).
 *
 * @returns true if ownership is valid, false if mismatch or missing (response sent)
 */
export function verifyDeviceOwnership(args: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  req: Request<any>;
  res: Response;
  jwtDeviceId: string | undefined;
  expectedDeviceId: string;
}): boolean {
  const { req, res, jwtDeviceId, expectedDeviceId } = args;

  // Fail closed: require jwtDeviceId to be present
  // This should never happen if authMiddleware is applied, but guard against misconfiguration
  if (!jwtDeviceId) {
    req.log.error(
      "verifyDeviceOwnership called without jwtDeviceId - possible middleware misconfiguration",
    );
    res.status(500).json({ error: "Internal server error" });
    return false;
  }

  if (jwtDeviceId !== expectedDeviceId) {
    req.log.warn(
      { jwtDeviceId, expectedDeviceId },
      "JWT deviceId mismatch - possible token misuse",
    );
    res.status(403).json({ error: "Device ID mismatch" });
    return false;
  }

  return true;
}
