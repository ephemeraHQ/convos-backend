import { describe, expect, it } from "vitest";
import { nextUtcBucket, truncUtcBucket } from "@/payments/credits/usage-window";
import { ymdUtc } from "@/payments/daily-refill/utc";

// 2026-01-15 is a Thursday; the Monday of its week is 2026-01-12.
const THURSDAY = new Date("2026-01-15T14:30:00Z");

describe("truncUtcBucket", () => {
  it("aligns to the start of the day/week(Monday)/month in UTC", () => {
    expect(ymdUtc(truncUtcBucket(THURSDAY, "day"))).toBe("2026-01-15");
    expect(truncUtcBucket(THURSDAY, "day").getUTCHours()).toBe(0);
    expect(ymdUtc(truncUtcBucket(THURSDAY, "week"))).toBe("2026-01-12");
    expect(ymdUtc(truncUtcBucket(THURSDAY, "month"))).toBe("2026-01-01");
  });
});

describe("nextUtcBucket", () => {
  it("advances one bucket from an aligned start", () => {
    expect(ymdUtc(nextUtcBucket(new Date("2026-01-15T00:00:00Z"), "day"))).toBe(
      "2026-01-16",
    );
    expect(
      ymdUtc(nextUtcBucket(new Date("2026-01-12T00:00:00Z"), "week")),
    ).toBe("2026-01-19");
    expect(
      ymdUtc(nextUtcBucket(new Date("2026-01-01T00:00:00Z"), "month")),
    ).toBe("2026-02-01");
  });

  it("truncates non-aligned input first, with no month-end overflow", () => {
    // Jan 31 must advance to Feb 1, not roll over to March.
    expect(
      ymdUtc(nextUtcBucket(new Date("2026-01-31T23:59:00Z"), "month")),
    ).toBe("2026-02-01");
    // Mid-week Thursday advances to the next Monday, not Thursday+7.
    expect(ymdUtc(nextUtcBucket(THURSDAY, "week"))).toBe("2026-01-19");
    // Mid-day advances to the next day's start.
    expect(ymdUtc(nextUtcBucket(THURSDAY, "day"))).toBe("2026-01-16");
  });
});
