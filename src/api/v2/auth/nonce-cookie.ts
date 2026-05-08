import { createHmac, timingSafeEqual } from "crypto";
import { NONCE_HMAC_SECRET } from "@/config";

export const NONCE_COOKIE_NAME = "__Host-convos_nonce";

export const NONCE_COOKIE_SET_FLAGS =
  "HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=300";

export const NONCE_COOKIE_CLEAR_FLAGS =
  "HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0";

const NONCE_HEX_RE = /^[0-9a-f]{64}$/;

function hmac(nonce: string): Buffer {
  return createHmac("sha256", NONCE_HMAC_SECRET).update(nonce).digest();
}

export function signNonce(nonce: string): string {
  return `${hmac(nonce).toString("base64url")}.${nonce}`;
}

export function readNonceFromCookie(cookie: string | undefined): string | null {
  if (!cookie) return null;
  const dot = cookie.indexOf(".");
  if (dot <= 0) return null;
  const nonce = cookie.slice(dot + 1);
  if (!NONCE_HEX_RE.test(nonce)) return null;
  let provided: Buffer;
  try {
    provided = Buffer.from(cookie.slice(0, dot), "base64url");
  } catch {
    return null;
  }
  const expected = hmac(nonce);
  if (provided.length !== expected.length) return null;
  if (!timingSafeEqual(provided, expected)) return null;
  return nonce;
}
