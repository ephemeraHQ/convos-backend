import { describe, expect, test } from "vitest";
import { bodySchema } from "@/api/v2/agent-templates/handlers/generations-post";
import { assertLegacyShapeValidates } from "./helpers/assertLegacyShapeValidates";

// Backwards-compatibility CONTRACT test for the generations request schema
// (CLAUDE.md append-only rule). Adding `variantId` must not reject the shapes
// shipped iOS builds already send. A future re-tightening fails CI here instead
// of breaking users whose app can't be force-updated.
describe("generations POST body schema — legacy client contract", () => {
  test("legacy ios-app body (no variantId) still validates", () => {
    const legacy = {
      source: "ios-app",
      inputs: { text: "make me a daily-trivia agent" },
      clientDeviceId: "0192f0a1-1111-7222-8333-444455556666",
      publishStatus: "unlisted",
    };
    assertLegacyShapeValidates(
      bodySchema,
      legacy,
      "legacy ios-app generations body (no variantId)",
    );
  });

  test("variantId is optional and accepted when present", () => {
    const parsed = bodySchema.safeParse({
      source: "ios-app",
      inputs: { text: "x" },
      variantId: "pr-1234",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.variantId).toBe("pr-1234");
    }
  });

  test("an unknown top-level key is still rejected (schema stays strict)", () => {
    const parsed = bodySchema.safeParse({
      source: "ios-app",
      inputs: { text: "x" },
      bogus: 1,
    });
    expect(parsed.success).toBe(false);
  });
});
