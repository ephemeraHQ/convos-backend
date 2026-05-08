import { describe, expect, test } from "bun:test";
import { ADMIN_ACCOUNT_ID, mintTemplateId } from "@/utils/prefixed-id";

describe("prefixed-id utilities", () => {
  test("ADMIN_ACCOUNT_ID is a valid UUID", () => {
    expect(ADMIN_ACCOUNT_ID).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  test("mintTemplateId returns tmpl_-prefixed ids with alphanumeric suffixes", () => {
    for (let i = 0; i < 100; i++) {
      expect(mintTemplateId()).toMatch(/^tmpl_[a-zA-Z0-9]{16,}$/);
    }
  });

  test("template id minters do not collide across 1000 successive calls", () => {
    const templateIds = Array.from({ length: 1000 }, () => mintTemplateId());

    expect(new Set(templateIds).size).toBe(1000);
  });
});
