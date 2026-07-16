import { describe, expect, it } from "vitest";
import { accountsListQuerySchema } from "@/api/v2/credits-admin/schemas/requests";

describe("accountsListQuerySchema — sort allowlist", () => {
  it("balance accepts sortBy=balance", () => {
    const p = accountsListQuerySchema.safeParse({
      mode: "balance",
      sortBy: "balance",
      sortDir: "asc",
    });
    expect(p.success).toBe(true);
  });

  it("balance rejects a foreign sortBy (tier)", () => {
    const p = accountsListQuerySchema.safeParse({
      mode: "balance",
      sortBy: "tier",
    });
    expect(p.success).toBe(false);
  });

  it("rejects a SQL-injection sortBy on every mode", () => {
    const evil = 'balance"; DROP TABLE "UserCredits"; --';
    for (const mode of ["balance", "broken", "grantKind"] as const) {
      const base = mode === "grantKind" ? { mode, kind: "manual" } : { mode };
      expect(
        accountsListQuerySchema.safeParse({ ...base, sortBy: evil }).success,
      ).toBe(false);
    }
    expect(
      accountsListQuerySchema.safeParse({
        mode: "activity",
        state: "active",
        sortBy: evil,
      }).success,
    ).toBe(false);
  });

  it("broken accepts currentPeriodEnd and tier", () => {
    for (const sortBy of ["balance", "currentPeriodEnd", "tier"]) {
      expect(
        accountsListQuerySchema.safeParse({ mode: "broken", sortBy }).success,
      ).toBe(true);
    }
  });

  it("defaults are applied when sort params omitted", () => {
    const p = accountsListQuerySchema.safeParse({
      mode: "grantKind",
      kind: "manual",
    });
    expect(p.success).toBe(true);
    if (p.success && p.data.mode === "grantKind") {
      expect(p.data.sortBy).toBe("latestGrantAt");
      expect(p.data.sortDir).toBe("desc");
    }
  });
});
