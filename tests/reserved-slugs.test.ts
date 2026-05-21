import { describe, expect, test } from "vitest";
import {
  isReservedSlug,
  isValidSlug,
  RESERVED_SLUGS,
  validateSlug,
  type SlugValidationErrorReason,
} from "@/utils/reserved-slugs";

function expectValidSlug(slug: string) {
  expect(validateSlug(slug)).toEqual({ valid: true, slug });
}

function expectInvalidSlug(slug: string, reason: SlugValidationErrorReason) {
  const result = validateSlug(slug);

  expect(result.valid).toBe(false);
  if (!result.valid) {
    expect(result.reason).toBe(reason);
  }
}

describe("reserved slug utilities", () => {
  test("reserved set is exactly the spec-locked slugs", () => {
    expect([...RESERVED_SLUGS].sort()).toEqual(
      [
        "generate",
        "publish",
        "fork",
        "search",
        "files",
        "templates",
        "skills",
      ].sort(),
    );

    for (const slug of RESERVED_SLUGS) {
      expect(isReservedSlug(slug)).toBe(true);
    }
  });

  test("non-reserved slugs return false", () => {
    for (const slug of ["brewski", "ledger", "foo-bar", ""]) {
      expect(isReservedSlug(slug)).toBe(false);
    }
  });

  test("isReservedSlug is lowercase-only", () => {
    expect(isReservedSlug("GENERATE")).toBe(false);
    expect(isReservedSlug("Publish")).toBe(false);
    expect(isReservedSlug("fOrK")).toBe(false);
  });

  test("validateSlug accepts valid lowercase alphanumeric and hyphen slugs", () => {
    expectValidSlug("a");
    expectValidSlug("a".repeat(64));
    expectValidSlug("foo-bar");
    expectValidSlug("abc123");
  });

  test("validateSlug rejects regex violations", () => {
    expectInvalidSlug("Brewski", "invalid_format");
    expectInvalidSlug("-leading", "invalid_format");
    expectInvalidSlug("", "invalid_format");
    expectInvalidSlug("trailing-", "invalid_format");
    expectInvalidSlug("agent--double", "invalid_format");
    expectInvalidSlug("a-", "invalid_format");
    expectInvalidSlug("-", "invalid_format");
  });

  test("validateSlug enforces the 64 character max length", () => {
    expectInvalidSlug("a".repeat(65), "too_long");
  });

  test("validateSlug rejects reserved slugs with a reserved reason", () => {
    const result = validateSlug("generate");

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe("reserved");
      expect(result.message).toContain("reserved");
    }
  });

  test("isValidSlug returns true for valid slugs and false for invalid/reserved", () => {
    expect(isValidSlug("foo-bar")).toBe(true);
    expect(isValidSlug("abc123")).toBe(true);
    expect(isValidSlug("UPPER")).toBe(false);
    expect(isValidSlug("trailing-")).toBe(false);
    expect(isValidSlug("generate")).toBe(false);
    expect(isValidSlug("a".repeat(65))).toBe(false);
  });
});
