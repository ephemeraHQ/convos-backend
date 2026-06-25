import { describe, expect, test } from "vitest";
import { normalizeJobTitle } from "@/api/v2/agent-templates/lib/normalize-job-title";

describe("normalizeJobTitle", () => {
  test("trims and collapses internal whitespace", () => {
    expect(normalizeJobTitle("  Trip   Planner  ")).toBe("Trip Planner");
    expect(normalizeJobTitle("Wake\n\tSurf  Boss")).toBe("Wake Surf Boss");
  });

  test("keeps a clean single-line title unchanged", () => {
    expect(normalizeJobTitle("Group Ledger")).toBe("Group Ledger");
  });

  test("returns null for blank, null, or undefined input", () => {
    expect(normalizeJobTitle("   ")).toBeNull();
    expect(normalizeJobTitle("")).toBeNull();
    expect(normalizeJobTitle(null)).toBeNull();
    expect(normalizeJobTitle(undefined)).toBeNull();
  });
});
