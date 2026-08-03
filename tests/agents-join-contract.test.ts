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

  test("legacy join body without idempotencyKey still validates", () => {
    assertLegacyShapeValidates(
      bodySchema,
      {
        slug: "join-token-abc123",
        templateId: "33333333-3333-4333-8333-333333333333",
      },
      "legacy join body (no idempotencyKey)",
    );
  });
});

describe("agents/join body schema — idempotencyKey", () => {
  const KEY = "6f0f7a8e-1b2c-4d3e-8f4a-5b6c7d8e9f0a";

  test("idempotencyKey is optional and accepted", () => {
    const parsed = bodySchema.safeParse({
      slug: "join-token-abc123",
      idempotencyKey: KEY,
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.idempotencyKey).toBe(KEY);
  });

  test("uppercase idempotencyKey is lowercased (early gate)", () => {
    const parsed = bodySchema.safeParse({
      slug: "join-token-abc123",
      idempotencyKey: KEY.toUpperCase(),
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.idempotencyKey).toBe(KEY);
  });

  test("non-uuid idempotencyKey is rejected", () => {
    const parsed = bodySchema.safeParse({
      slug: "join-token-abc123",
      idempotencyKey: "not-a-uuid",
    });
    expect(parsed.success).toBe(false);
  });
});

describe("agents/join body schema — ownerProfileName", () => {
  test("legacy join body without ownerProfileName still validates", () => {
    assertLegacyShapeValidates(
      bodySchema,
      { conversationId: "deadbeefcafe1234", name: "My Agent" },
      "legacy join body (no ownerProfileName)",
    );
  });

  test("ownerProfileName is optional, accepted, and trimmed", () => {
    const parsed = bodySchema.safeParse({
      conversationId: "deadbeefcafe1234",
      ownerProfileName: "  Saul ",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.ownerProfileName).toBe("Saul");
    }
  });

  test("blank ownerProfileName collapses to absent", () => {
    const parsed = bodySchema.safeParse({
      conversationId: "deadbeefcafe1234",
      ownerProfileName: "   ",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.ownerProfileName).toBeUndefined();
    }
  });
});
