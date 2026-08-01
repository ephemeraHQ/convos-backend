import { describe, expect, test } from "vitest";
import { maskKeyPrefix } from "@/utils/mask";

describe("maskKeyPrefix", () => {
  test("returns a placeholder for an empty key", () => {
    expect(maskKeyPrefix("")).toBe("(empty)");
  });

  test("keeps only the first four characters and the length", () => {
    expect(maskKeyPrefix("sk_live_abcdef123456")).toBe("sk_l... (len=20)");
  });

  test("never leaks the tail of the key", () => {
    const key = "abcdSECRETTAIL";
    expect(maskKeyPrefix(key)).not.toContain("SECRETTAIL");
  });

  test("handles keys shorter than the prefix window", () => {
    expect(maskKeyPrefix("ab")).toBe("ab... (len=2)");
  });
});
