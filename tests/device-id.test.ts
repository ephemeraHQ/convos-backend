import { describe, expect, test } from "bun:test";
import { DEVICE_ID_MAX_LENGTH, deviceIdSchema } from "@/utils/device-id";

describe("deviceIdSchema", () => {
  test("accepts iOS UUID", () => {
    const value = "123e4567-e89b-12d3-a456-426614174000";
    expect(deviceIdSchema.parse(value)).toBe(value);
  });

  test("accepts Android ANDROID_ID-like hex", () => {
    const value = "9774d56d682e549c";
    expect(deviceIdSchema.parse(value)).toBe(value);
  });

  test("accepts Firebase Installation ID-like format", () => {
    const value = "cJNt-u7vTxKXEoJi1b9sMz";
    expect(deviceIdSchema.parse(value)).toBe(value);
  });

  test("trims leading/trailing whitespace", () => {
    expect(deviceIdSchema.parse("  test-id  ")).toBe("test-id");
  });

  test("rejects empty string after trim", () => {
    expect(() => deviceIdSchema.parse("   ")).toThrow();
  });

  test("rejects over max length", () => {
    expect(() =>
      deviceIdSchema.parse("a".repeat(DEVICE_ID_MAX_LENGTH + 1)),
    ).toThrow();
  });
});
