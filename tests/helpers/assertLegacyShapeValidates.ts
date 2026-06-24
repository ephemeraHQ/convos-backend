import { expect } from "vitest";
import type { ZodType } from "zod";

/**
 * Contract-test helper for the append-only / backwards-compatible client-API
 * rule (see CLAUDE.md). Mobile clients can't be force-updated, so a request
 * schema must keep accepting the shapes that shipped builds already send.
 *
 * `assertLegacyShapeValidates(schema, legacyBody)` asserts that a known legacy
 * client request body STILL passes a zod schema — i.e. `safeParse().success`
 * is `true` and the schema does not throw. Pin one of these per client-facing
 * request schema; a future tightening that re-breaks shipped clients then fails
 * the test (and CI) instead of breaking users in production.
 *
 * Generic on purpose so it can pin other client-facing schemas later — pass any
 * `ZodType` and the historical body that older clients are known to send.
 */
export function assertLegacyShapeValidates(
  schema: ZodType,
  legacyBody: unknown,
  /** Optional label surfaced in the assertion failure message. */
  label = "legacy client request body",
): void {
  const result = schema.safeParse(legacyBody);
  expect(
    result.success,
    result.success
      ? undefined
      : `${label} no longer validates against the schema — this is a ` +
          `backwards-incompatible change for shipped clients. Issues: ` +
          JSON.stringify(result.error.issues, null, 2),
  ).toBe(true);
}
