import { describe, expect, test } from "bun:test";
import {
  startOfNextUtcDay,
  startOfTodayUtc,
  ymdUtc,
} from "@/payments/daily-refill/utc";

describe("startOfTodayUtc", () => {
  test("midday UTC → midnight UTC same day", () => {
    const now = new Date(Date.UTC(2026, 4, 15, 13, 30, 0));
    expect(startOfTodayUtc(now).toISOString()).toBe("2026-05-15T00:00:00.000Z");
  });

  test("midnight UTC → itself", () => {
    const now = new Date(Date.UTC(2026, 4, 15, 0, 0, 0));
    expect(startOfTodayUtc(now).toISOString()).toBe("2026-05-15T00:00:00.000Z");
  });

  test("23:59:59.999 UTC → midnight that day", () => {
    const now = new Date(Date.UTC(2026, 4, 15, 23, 59, 59, 999));
    expect(startOfTodayUtc(now).toISOString()).toBe("2026-05-15T00:00:00.000Z");
  });
});

describe("startOfNextUtcDay", () => {
  test("midday UTC → midnight next day", () => {
    const now = new Date(Date.UTC(2026, 4, 15, 13, 30, 0));
    expect(startOfNextUtcDay(now).toISOString()).toBe(
      "2026-05-16T00:00:00.000Z",
    );
  });

  test("last second of month → midnight first of next month", () => {
    const now = new Date(Date.UTC(2026, 4, 31, 23, 59, 59));
    expect(startOfNextUtcDay(now).toISOString()).toBe(
      "2026-06-01T00:00:00.000Z",
    );
  });

  test("last second of year → first of next year", () => {
    const now = new Date(Date.UTC(2026, 11, 31, 23, 59, 59));
    expect(startOfNextUtcDay(now).toISOString()).toBe(
      "2027-01-01T00:00:00.000Z",
    );
  });
});

describe("ymdUtc", () => {
  test("formats as YYYY-MM-DD", () => {
    expect(ymdUtc(new Date(Date.UTC(2026, 4, 15, 13, 30)))).toBe("2026-05-15");
  });

  test("zero-pads single-digit month/day", () => {
    expect(ymdUtc(new Date(Date.UTC(2026, 0, 5, 0, 0)))).toBe("2026-01-05");
  });
});
