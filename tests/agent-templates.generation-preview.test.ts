/**
 * Unit tests for `previewResponseFields` — the serializer that narrows the raw
 * `preview` / `progressPhrases` JSONB columns into the in-progress poll fields.
 *
 * The row columns are `unknown` at the Prisma boundary, so malformed/legacy
 * JSONB must never leak across the wire contract. These cover the structural
 * validation (per-field string narrowing) added for that guarantee.
 */

import { describe, expect, test } from "vitest";
import { previewResponseFields } from "@/api/v2/agent-templates/lib/generation-preview";

describe("previewResponseFields — preview", () => {
  test("drops non-object preview (null, string, number, array)", () => {
    expect(previewResponseFields(null, undefined).preview).toBeUndefined();
    expect(previewResponseFields("nope", undefined).preview).toBeUndefined();
    expect(previewResponseFields(42, undefined).preview).toBeUndefined();
    expect(previewResponseFields(["a"], undefined).preview).toBeUndefined();
  });

  test("omits preview when no identity field is a string", () => {
    expect(previewResponseFields({}, undefined).preview).toBeUndefined();
    expect(
      previewResponseFields({ agentName: 123, emoji: null }, undefined).preview,
    ).toBeUndefined();
  });

  test("keeps only the string identity fields, dropping non-strings and extras", () => {
    const { preview } = previewResponseFields(
      {
        agentName: "Wave Boss",
        emoji: "🏄",
        description: "surf crew",
        prompt: "you are wave boss", // not an identity field — dropped
        tools: ["Search"], // dropped
        category: 5, // wrong type — dropped
      },
      undefined,
    );
    expect(preview).toEqual({
      agentName: "Wave Boss",
      emoji: "🏄",
      description: "surf crew",
    });
  });

  test("supports a partial identity (only the present string fields)", () => {
    expect(
      previewResponseFields({ agentName: "Wave Boss" }, undefined).preview,
    ).toEqual({ agentName: "Wave Boss" });
  });
});

describe("previewResponseFields — progressPhrases", () => {
  test("drops a non-array progressPhrases", () => {
    expect(
      previewResponseFields(undefined, "not-an-array").progressPhrases,
    ).toBeUndefined();
    expect(
      previewResponseFields(undefined, null).progressPhrases,
    ).toBeUndefined();
    expect(
      previewResponseFields(undefined, {}).progressPhrases,
    ).toBeUndefined();
  });

  test("filters non-string and blank entries", () => {
    expect(
      previewResponseFields(undefined, [
        "Writing",
        "",
        "   ",
        7,
        null,
        "Shaping",
      ]).progressPhrases,
    ).toEqual(["Writing", "Shaping"]);
  });

  test("omits progressPhrases when nothing survives the filter", () => {
    expect(
      previewResponseFields(undefined, ["", "  ", 1]).progressPhrases,
    ).toBeUndefined();
    expect(
      previewResponseFields(undefined, []).progressPhrases,
    ).toBeUndefined();
  });
});
