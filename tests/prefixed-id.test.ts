import { describe, expect, test } from "bun:test";
import { mintAccountId, mintTemplateId } from "@/utils/prefixed-id";

describe("prefixed-id utilities", () => {
  test("mintAccountId returns acct_-prefixed ids with alphanumeric suffixes", () => {
    for (let i = 0; i < 100; i++) {
      expect(mintAccountId()).toMatch(/^acct_[a-zA-Z0-9]{16,}$/);
    }
  });

  test("mintTemplateId returns tmpl_-prefixed ids with alphanumeric suffixes", () => {
    for (let i = 0; i < 100; i++) {
      expect(mintTemplateId()).toMatch(/^tmpl_[a-zA-Z0-9]{16,}$/);
    }
  });

  test("minters do not collide across 1000 successive calls", () => {
    const accountIds = Array.from({ length: 1000 }, () => mintAccountId());
    const templateIds = Array.from({ length: 1000 }, () => mintTemplateId());

    expect(new Set(accountIds).size).toBe(1000);
    expect(new Set(templateIds).size).toBe(1000);
  });
});
