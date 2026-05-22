import { describe, expect, test } from "vitest";
import { ADMIN_ACCOUNT_ID } from "@/utils/constants";

describe("constants", () => {
  test("ADMIN_ACCOUNT_ID is a valid UUID", () => {
    expect(ADMIN_ACCOUNT_ID).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });
});
