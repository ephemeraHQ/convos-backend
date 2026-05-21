import { describe, expect, test } from "vitest";
import {
  NONCE_COOKIE_CLEAR_FLAGS,
  NONCE_COOKIE_NAME,
  NONCE_COOKIE_SET_FLAGS,
  readNonceFromCookie,
  signNonce,
} from "@/api/v2/auth/nonce-cookie";

const VALID_NONCE = "a".repeat(64); // 64 hex chars = 32 bytes

describe("nonce-cookie", () => {
  test("cookie name uses __Host- prefix", () => {
    expect(NONCE_COOKIE_NAME).toBe("__Host-convos_nonce");
  });

  test("set flags include HttpOnly, Secure, SameSite=Strict, Path=/, Max-Age=300", () => {
    expect(NONCE_COOKIE_SET_FLAGS).toContain("HttpOnly");
    expect(NONCE_COOKIE_SET_FLAGS).toContain("Secure");
    expect(NONCE_COOKIE_SET_FLAGS).toContain("SameSite=Strict");
    expect(NONCE_COOKIE_SET_FLAGS).toContain("Path=/");
    expect(NONCE_COOKIE_SET_FLAGS).toContain("Max-Age=300");
  });

  test("clear flags repeat full attribute set", () => {
    expect(NONCE_COOKIE_CLEAR_FLAGS).toContain("HttpOnly");
    expect(NONCE_COOKIE_CLEAR_FLAGS).toContain("Secure");
    expect(NONCE_COOKIE_CLEAR_FLAGS).toContain("SameSite=Strict");
    expect(NONCE_COOKIE_CLEAR_FLAGS).toContain("Path=/");
    expect(NONCE_COOKIE_CLEAR_FLAGS).toContain("Max-Age=0");
  });

  test("signNonce returns format <hmac>.<nonce>", () => {
    const cookie = signNonce(VALID_NONCE);
    const parts = cookie.split(".");
    expect(parts.length).toBe(2);
    expect(parts[1]).toBe(VALID_NONCE);
  });

  test("readNonceFromCookie returns nonce for a valid signed cookie", () => {
    const cookie = signNonce(VALID_NONCE);
    expect(readNonceFromCookie(cookie)).toBe(VALID_NONCE);
  });

  test("readNonceFromCookie returns null for tampered HMAC", () => {
    const cookie = signNonce(VALID_NONCE);
    const tampered = "AAAA" + cookie.slice(4);
    expect(readNonceFromCookie(tampered)).toBeNull();
  });

  test("readNonceFromCookie returns null for tampered nonce", () => {
    const cookie = signNonce(VALID_NONCE);
    const dot = cookie.indexOf(".");
    const tampered = cookie.slice(0, dot) + "." + "b".repeat(64);
    expect(readNonceFromCookie(tampered)).toBeNull();
  });

  test("readNonceFromCookie returns null for non-hex nonce", () => {
    const badHexNonce = "z".repeat(64);
    const cookie = signNonce(badHexNonce);
    expect(readNonceFromCookie(cookie)).toBeNull();
  });

  test("readNonceFromCookie returns null for missing cookie / malformed string", () => {
    expect(readNonceFromCookie(undefined)).toBeNull();
    expect(readNonceFromCookie("")).toBeNull();
    expect(readNonceFromCookie("nodot")).toBeNull();
    expect(readNonceFromCookie(".no_hmac")).toBeNull();
  });
});
