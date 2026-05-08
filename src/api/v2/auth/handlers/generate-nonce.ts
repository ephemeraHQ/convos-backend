import type { Request, Response } from "express";
import { issueNonce } from "@/api/v2/auth/auth-nonce.repository";
import {
  NONCE_COOKIE_NAME,
  NONCE_COOKIE_SET_FLAGS,
  signNonce,
} from "@/api/v2/auth/nonce-cookie";

export async function generateNonce(_req: Request, res: Response) {
  const nonce = await issueNonce();
  const value = signNonce(nonce);
  res.append(
    "Set-Cookie",
    `${NONCE_COOKIE_NAME}=${value}; ${NONCE_COOKIE_SET_FLAGS}`,
  );
  res.status(200).json({});
}
