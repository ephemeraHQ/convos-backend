import { describe, expect, test } from "bun:test";
import { isXmtpProduction, parseXmtpEnv, shouldUseDevBehavior } from "@/config";

describe("XMTP environment helpers", () => {
  test("treats only production as production", () => {
    expect(isXmtpProduction("production")).toBe(true);
    expect(isXmtpProduction("dev")).toBe(false);
    expect(isXmtpProduction("testnet")).toBe(false);
  });

  test("treats testnet as dev-like behavior", () => {
    expect(shouldUseDevBehavior("dev")).toBe(true);
    expect(shouldUseDevBehavior("testnet")).toBe(true);
    expect(shouldUseDevBehavior("production")).toBe(false);
  });

  test("rejects invalid environment values", () => {
    expect(() => parseXmtpEnv("local")).toThrow(
      "Invalid XMTP_ENV: local. Must be one of: production, testnet, dev",
    );
  });
});
