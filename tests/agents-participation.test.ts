import { describe, expect, test } from "vitest";
import { bodySchema } from "@/api/v2/agents/handlers/participation";

// Request-shape tests for PATCH /api/v2/agents/:instanceId/participation.
// The endpoint is the app's only route to the runtime control plane, and
// Paused depends on it reaching that plane, so the shape it accepts is worth
// pinning before shipped clients start sending it.
describe("agents participation body schema", () => {
  test("each level is accepted on its own", () => {
    for (const mode of ["speak", "mention", "paused"] as const) {
      expect(bodySchema.safeParse({ mode }).success).toBe(true);
    }
  });

  test("a cooldown alone is accepted, since the level is a partial update", () => {
    expect(bodySchema.safeParse({ cooldownSeconds: 15 }).success).toBe(true);
  });

  test("zero is a real value: it turns the explicit hold off", () => {
    expect(bodySchema.safeParse({ cooldownSeconds: 0 }).success).toBe(true);
  });

  test("both fields together are accepted", () => {
    expect(
      bodySchema.safeParse({ mode: "speak", cooldownSeconds: 30 }).success,
    ).toBe(true);
  });

  test("an empty body is rejected: it would be a write that changes nothing", () => {
    expect(bodySchema.safeParse({}).success).toBe(false);
  });

  test("an unknown level is rejected", () => {
    expect(bodySchema.safeParse({ mode: "listen" }).success).toBe(false);
  });

  test("a negative or fractional cooldown is rejected", () => {
    expect(bodySchema.safeParse({ cooldownSeconds: -1 }).success).toBe(false);
    expect(bodySchema.safeParse({ cooldownSeconds: 1.5 }).success).toBe(false);
  });

  test("an absurd cooldown is rejected rather than passed upstream", () => {
    expect(bodySchema.safeParse({ cooldownSeconds: 100_000 }).success).toBe(
      false,
    );
  });

  test("unknown keys are rejected so a typo is not silently ignored", () => {
    expect(
      bodySchema.safeParse({ mode: "paused", modo: "paused" }).success,
    ).toBe(false);
  });
});
