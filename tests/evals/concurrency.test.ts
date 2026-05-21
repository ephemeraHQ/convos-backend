/**
 * Offline unit tests for the bounded-parallelism map. No network.
 */

import { describe, expect, test } from "vitest";
import { mapLimit } from "./lib/concurrency";

describe("mapLimit", () => {
  test("preserves input order regardless of completion order", async () => {
    const out = await mapLimit([30, 10, 20], 3, async (ms, i) => {
      await new Promise((r) => setTimeout(r, ms));
      return i;
    });
    expect(out).toEqual([0, 1, 2]);
  });

  test("never exceeds the concurrency limit", async () => {
    let inFlight = 0;
    let peak = 0;
    await mapLimit(
      Array.from({ length: 10 }, (_u, i) => i),
      3,
      async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return null;
      },
    );
    expect(peak).toBeLessThanOrEqual(3);
  });

  test("clamps a limit of 0 to 1 (still processes everything)", async () => {
    const seen: number[] = [];
    const out = await mapLimit([1, 2, 3], 0, (x) => {
      seen.push(x);
      return Promise.resolve(x);
    });
    expect(out).toEqual([1, 2, 3]);
    expect(seen.length).toBe(3);
  });

  test("handles an empty list", async () => {
    expect(await mapLimit([], 4, (x) => Promise.resolve(x))).toEqual([]);
  });
});
