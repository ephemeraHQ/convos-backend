import { describe, expect, test } from "vitest";
import { accountIdSchema } from "@/utils/account-id";
import { ADMIN_ACCOUNT_ID } from "@/utils/constants";

describe("accountIdSchema", () => {
  test("accepts a v4 uuid", () => {
    const result = accountIdSchema.safeParse(
      "11111111-1111-4111-8111-111111111111",
    );
    expect(result.success).toBe(true);
  });

  test("accepts the ADMIN seed uuid", () => {
    const result = accountIdSchema.safeParse(ADMIN_ACCOUNT_ID);
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
