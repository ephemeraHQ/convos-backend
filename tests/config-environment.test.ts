import { describe, expect, test } from "bun:test";
import { isXmtpProduction, parseXmtpEnv, shouldUseDevBehavior } from "@/config";

describe("XMTP environment helpers", () => {
  test("treats only production as production", () => {
    expect(isXmtpProduction("production")).toBe(true);
    expect(isXmtpProduction("dev")).toBe(false);
    expect(isXmtpProduction("testnet")).toBe(false);
    expect(isXmtpProduction("local")).toBe(false);
  });

  test("treats testnet as dev-like behavior", () => {
    expect(shouldUseDevBehavior("dev")).toBe(true);
    expect(shouldUseDevBehavior("testnet")).toBe(true);
    expect(shouldUseDevBehavior("local")).toBe(true);
    expect(shouldUseDevBehavior("production")).toBe(false);
  });

  test("rejects invalid environment values", () => {
    expect(() => parseXmtpEnv("staging")).toThrow(
      "Invalid XMTP_ENV: staging. Must be one of: production, testnet, dev, local",
    );
  });
});
