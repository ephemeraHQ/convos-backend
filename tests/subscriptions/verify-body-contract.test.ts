import { describe, expect, test } from "vitest";
import { verifyBodySchema } from "@/api/v2/accounts/handlers/subscription-verify";
import { assertLegacyShapeValidates } from "../helpers/assertLegacyShapeValidates";

// Backwards-compatibility CONTRACT test for the subscription-verify request
// schema. PR #290 made `platform` a required discriminator
// (z.discriminatedUnion("platform", …)), which silently 400'd every shipped iOS
// build still POSTing a bare `{ jwsRepresentation }` (the original PR #215
// contract). PR #329 restored compat by defaulting a missing `platform` to
// "apple" before the union parse.
//
// This test pins that legacy shape directly against the schema (no DB / HTTP
// needed). It is a tripwire for the append-only client-API rule in CLAUDE.md:
// a future change that re-tightens the schema (e.g. dropping the default and
// requiring `platform`) makes this fail in CI instead of breaking users whose
// app can't be force-updated.
describe("subscription-verify body schema — legacy client contract", () => {
  test("bare { jwsRepresentation } (no platform) still validates", () => {
    // The exact shape pre-`platform` iOS builds send: no discriminator, just
    // the signed transaction. "valid-looking" = a non-empty JWS-shaped string
    // so it clears the `z.string().min(1)` gate.
    const legacyBody = {
      jwsRepresentation: "eyJhbGciOiJFUzI1NiJ9.eyJ0eCI6IjEifQ.signature",
    };

    assertLegacyShapeValidates(
      verifyBodySchema,
      legacyBody,
      "legacy verify body { jwsRepresentation } (no platform)",
    );

    // And it must route to the Apple arm with the defaulted discriminator, so
    // the handler downstream still reads it as an Apple verification.
    const parsed = verifyBodySchema.safeParse(legacyBody);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).toMatchObject({
        platform: "apple",
        jwsRepresentation: legacyBody.jwsRepresentation,
      });
    }
  });
});
