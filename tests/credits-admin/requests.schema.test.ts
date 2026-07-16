import { describe, expect, it } from "vitest";
import {
  accountsListQuerySchema,
  ledgerQuerySchema,
} from "@/api/v2/credits-admin/schemas/requests";

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

describe("ledgerQuerySchema — ledger filter", () => {
  it("accepts no params (back-compat)", () => {
    expect(ledgerQuerySchema.safeParse({}).success).toBe(true);
  });

  it("accepts kind=subscription and every grant kind", () => {
    for (const kind of [
      "subscription",
      "sub_grant",
      "sub_forfeit",
      "signup_bonus",
      "daily_refill",
      "manual",
    ]) {
      expect(ledgerQuerySchema.safeParse({ kind }).success).toBe(true);
    }
  });

  it("rejects an unknown kind", () => {
    expect(ledgerQuerySchema.safeParse({ kind: "bogus" }).success).toBe(false);
  });

  it("accepts reason consume/grant/adjust and rejects the dead refill value", () => {
    for (const reason of ["consume", "grant", "adjust"]) {
      expect(ledgerQuerySchema.safeParse({ reason }).success).toBe(true);
    }
    expect(ledgerQuerySchema.safeParse({ reason: "refill" }).success).toBe(
      false,
    );
  });

  it("coerces YYYY-MM-DD dates to Date and rejects garbage", () => {
    const ok = ledgerQuerySchema.safeParse({
      from: "2026-07-01",
      to: "2026-07-17",
    });
    expect(ok.success).toBe(true);
    if (ok.success) {
      expect(ok.data.from).toBeInstanceOf(Date);
      expect(ok.data.to).toBeInstanceOf(Date);
    }
    expect(ledgerQuerySchema.safeParse({ to: "not-a-date" }).success).toBe(
      false,
    );
  });
});
