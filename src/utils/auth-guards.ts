import type { Request, Response } from "express";

/**
 * Verifies that the JWT token's deviceId matches the expected deviceId.
 * Sends a 403 response and returns false if there's a mismatch.
 *
 * @returns true if ownership is valid (or no JWT auth), false if mismatch (response sent)
 */
export function verifyDeviceOwnership(args: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  req: Request<any>;
  res: Response;
  jwtDeviceId: string | undefined;
  expectedDeviceId: string;
}): boolean {
  const { req, res, jwtDeviceId, expectedDeviceId } = args;

  if (jwtDeviceId && jwtDeviceId !== expectedDeviceId) {
    req.log.warn(
      { jwtDeviceId, expectedDeviceId },
      "JWT deviceId mismatch - possible token misuse",
    );
    res.status(403).json({ error: "Device ID mismatch" });
    return false;
  }

  return true;
}
