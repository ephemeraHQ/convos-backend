import { describe, expect, test } from "vitest";
import {
  DB_CONNECT_RETRY_DELAY_MS,
  DEFAULT_DB_CONNECT_BUDGET_SECONDS,
  MAX_DB_CONNECT_BUDGET_SECONDS,
  parseBudgetSeconds,
  waitForDatabase,
  withTimeout,
  type WaitDeps,
} from "@/db-wait";

/** Deterministic fake clock: `sleep` advances virtual time, nothing blocks. */
const makeDeps = (probe: () => Promise<void>) => {
  let clock = 0;
  const logs: string[] = [];
  const deps: WaitDeps = {
    probe,
    now: () => clock,
    sleep: (ms: number) => {
      clock += ms;
      return Promise.resolve();
    },
    log: (message: string) => {
      logs.push(message);
    },
  };
  return { deps, logs, clockAt: () => clock };
};

describe("waitForDatabase", () => {
  test("returns after one attempt when the database is already up", async () => {
    const { deps, clockAt } = makeDeps(() => Promise.resolve());

    await expect(waitForDatabase(90, deps)).resolves.toBe(1);
    expect(clockAt()).toBe(0);
  });

  test("retries until the probe succeeds", async () => {
    let calls = 0;
    const { deps, clockAt } = makeDeps(() => {
      calls += 1;
      return calls < 4
        ? Promise.reject(new Error("P1001: cannot reach database server"))
        : Promise.resolve();
    });

    await expect(waitForDatabase(90, deps)).resolves.toBe(4);
    expect(calls).toBe(4);
    expect(clockAt()).toBe(3 * DB_CONNECT_RETRY_DELAY_MS);
  });

  test("throws once the budget is exhausted, quoting the last error", async () => {
    const { deps, clockAt } = makeDeps(() =>
      Promise.reject(new Error("P1001: cannot reach database server")),
    );

    await expect(waitForDatabase(10, deps)).rejects.toThrow(
      /not reachable within 10s/,
    );
    await expect(waitForDatabase(10, deps)).rejects.toThrow(
      /P1001: cannot reach database server/,
    );
    // 10s budget at a 2s retry delay: it must not run past the deadline.
    expect(clockAt()).toBeLessThanOrEqual(20_000);
  });

  test("never sleeps past the deadline", async () => {
    const { deps, clockAt } = makeDeps(() => Promise.reject(new Error("down")));

    await expect(waitForDatabase(1, deps)).rejects.toThrow(/not reachable/);
    // Budget is shorter than one retry delay, so it must fail immediately.
    expect(clockAt()).toBe(0);
  });
});

describe("withTimeout", () => {
  test("passes a value through when the promise settles in time", async () => {
    await expect(withTimeout(Promise.resolve("ok"), 1_000, "p")).resolves.toBe(
      "ok",
    );
  });

  test("propagates the promise's own rejection", async () => {
    await expect(
      withTimeout(Promise.reject(new Error("boom")), 1_000, "p"),
    ).rejects.toThrow(/boom/);
  });

  test("rejects when the promise outlives the cap", async () => {
    // The real hazard: a connection attempt that hangs far past the budget.
    const never = new Promise<string>(() => undefined);
    await expect(withTimeout(never, 10, "[db-wait] probe")).rejects.toThrow(
      /\[db-wait\] probe timed out after 10ms/,
    );
  });

  test("absorbs a late rejection so Node does not die on it", async () => {
    const late = new Promise<string>((_, reject) => {
      setTimeout(() => {
        reject(new Error("late failure"));
      }, 30);
    });
    await expect(withTimeout(late, 5, "p")).rejects.toThrow(/timed out/);
    // Give the loser time to reject; an unhandled rejection would fail the run.
    await new Promise((resolve) => setTimeout(resolve, 60));
  });
});

describe("parseBudgetSeconds", () => {
  test("defaults when unset or blank", () => {
    expect(parseBudgetSeconds(undefined)).toBe(
      DEFAULT_DB_CONNECT_BUDGET_SECONDS,
    );
    expect(parseBudgetSeconds("")).toBe(DEFAULT_DB_CONNECT_BUDGET_SECONDS);
    expect(parseBudgetSeconds("   ")).toBe(DEFAULT_DB_CONNECT_BUDGET_SECONDS);
  });

  test("defaults on non-positive or non-numeric values", () => {
    expect(parseBudgetSeconds("0")).toBe(DEFAULT_DB_CONNECT_BUDGET_SECONDS);
    expect(parseBudgetSeconds("-5")).toBe(DEFAULT_DB_CONNECT_BUDGET_SECONDS);
    expect(parseBudgetSeconds("banana")).toBe(
      DEFAULT_DB_CONNECT_BUDGET_SECONDS,
    );
  });

  test("accepts a positive integer", () => {
    expect(parseBudgetSeconds("30")).toBe(30);
    expect(parseBudgetSeconds(" 240 ")).toBe(240);
  });

  test("defaults on a numeric prefix rather than silently truncating", () => {
    // Number.parseInt("10seconds") is 10 — a budget the operator never asked
    // for, and shorter than an Aurora resume takes.
    expect(parseBudgetSeconds("10seconds")).toBe(
      DEFAULT_DB_CONNECT_BUDGET_SECONDS,
    );
    expect(parseBudgetSeconds("90s")).toBe(DEFAULT_DB_CONNECT_BUDGET_SECONDS);
    expect(parseBudgetSeconds("1e3")).toBe(DEFAULT_DB_CONNECT_BUDGET_SECONDS);
    expect(parseBudgetSeconds("12.5")).toBe(DEFAULT_DB_CONNECT_BUDGET_SECONDS);
  });

  test("clamps an absurd budget so the wait stays bounded", () => {
    expect(parseBudgetSeconds("999999999999999")).toBe(
      MAX_DB_CONNECT_BUDGET_SECONDS,
    );
    expect(parseBudgetSeconds(String(MAX_DB_CONNECT_BUDGET_SECONDS))).toBe(
      MAX_DB_CONNECT_BUDGET_SECONDS,
    );
  });
});
