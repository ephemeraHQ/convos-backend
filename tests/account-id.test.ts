import { describe, expect, test } from "vitest";
import { accountIdSchema } from "@/utils/account-id";

describe("accountIdSchema", () => {
  test("accepts a v4 uuid", () => {
    const result = accountIdSchema.safeParse(
      "11111111-1111-4111-8111-111111111111",
    );
    expect(result.success).toBe(true);
  });

  test("accepts the ADMIN seed uuid", () => {
    const result = accountIdSchema.safeParse(
      "48a05ef4-4a71-57a0-957f-a3d410992b31",
    );
    expect(result.success).toBe(true);
  });

  test.each([
    ["garbage string", "not-a-uuid"],
    ["uppercase garbage", "NOT-A-UUID-AT-ALL-NOPE"],
    ["empty string", ""],
    ["uuid with trailing junk", "11111111-1111-4111-8111-111111111111x"],
    ["null", null],
    ["number", 42],
    ["undefined", undefined],
  ])("rejects %s", (_label, value) => {
    const result = accountIdSchema.safeParse(value);
    expect(result.success).toBe(false);
  });
});
