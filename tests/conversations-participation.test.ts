import { describe, expect, test } from "vitest";
import { bodySchema } from "@/api/v2/conversations/handlers/participation";

// Request-shape tests for PATCH /api/v2/conversations/:conversationId/participation.
// The endpoint is the app's only route to the runtime control plane, and Paused
// depends on it reaching that plane, so the shape it accepts is worth pinning
// before shipped clients start sending it.
describe("conversation participation body schema", () => {
  test("each level is accepted on its own", () => {
    for (const mode of ["speak", "mention", "paused"] as const) {
      expect(bodySchema.safeParse({ mode }).success).toBe(true);
    }
  });

  test("an empty body is rejected: it would be a write that changes nothing", () => {
    expect(bodySchema.safeParse({}).success).toBe(false);
  });

  test("an unknown level is rejected", () => {
    expect(bodySchema.safeParse({ mode: "listen" }).success).toBe(false);
  });

  test("the cooldown is no longer a client-settable field", () => {
    // The hold is a harness default now, derived from the conversation's own
    // activity rather than a number the app sends. A client still sending one
    // is a stale build, and silently accepting it would hide that.
    expect(
      bodySchema.safeParse({ mode: "speak", cooldownSeconds: 30 }).success,
    ).toBe(false);
  });

  test("unknown keys are rejected so a typo is not silently ignored", () => {
    expect(
      bodySchema.safeParse({ mode: "paused", modo: "paused" }).success,
    ).toBe(false);
  });
});
