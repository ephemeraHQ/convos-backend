import { describe, expect, test } from "vitest";
import { bodySchema } from "@/api/v2/agents/handlers/join";
import { assertLegacyShapeValidates } from "./helpers/assertLegacyShapeValidates";

// Backwards-compatibility CONTRACT test for the agents/join request schema
// (CLAUDE.md append-only rule). Adding `options.variantId` must not reject the
// shapes shipped iOS builds already send. A future re-tightening fails CI here
// instead of breaking users whose app can't be force-updated.
describe("agents/join body schema — legacy client contract", () => {
  test("legacy invite join (slug + options, no variantId) still validates", () => {
    assertLegacyShapeValidates(
      bodySchema,
      {
        slug: "join-token-abc123",
        options: { skipGreeting: true, onboarding: "agent-builder" },
      },
      "legacy join body (no variantId)",
    );
  });

  test("legacy direct-add join (conversationId only) still validates", () => {
    assertLegacyShapeValidates(
      bodySchema,
      { conversationId: "deadbeefcafe1234" },
      "legacy direct-add join body",
    );
  });

  test("variantId is optional and accepted on options", () => {
    const parsed = bodySchema.safeParse({
      slug: "join-token-abc123",
      options: { variantId: "pr-1234" },
    });
    expect(parsed.success).toBe(true);
  });

  test("an unknown option key is still rejected (options stays strict)", () => {
    const parsed = bodySchema.safeParse({
      slug: "join-token-abc123",
      options: { bogus: 1 },
    });
    expect(parsed.success).toBe(false);
  });
});
