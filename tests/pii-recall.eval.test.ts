/**
 * CI recall eval for the deterministic PII floor.
 *
 * The LLM is the primary PII detector but has no recall guarantee, and
 * fail-closed only catches scan ERRORS, not detection MISSES. So the redaction
 * stage also runs `detectStructuredPii` — high-precision regexes for the
 * structured identifiers (email / phone / SSN / credit card) that are the
 * highest-risk and most mechanically detectable.
 *
 * This eval asserts 100% recall of that deterministic layer over a fixture set:
 * every known structured-PII span MUST be caught (a miss here would silently
 * persist that PII). It runs in CI with no model and no DB. Contextual PII
 * (real-person names, "Maria in HR", intl addresses) is the model's job and is
 * covered by the gated live stress harness, not asserted here.
 */

import { describe, expect, test } from "vitest";
import {
  detectStructuredPii,
  type RedactableField,
} from "@/api/v2/agent-templates/services/moderation";

interface Fixture {
  name: string;
  field: RedactableField;
  text: string;
  /** Exact spans that MUST appear among the detected findings. */
  mustCatch: string[];
}

const FIXTURES: Fixture[] = [
  // --- email ---
  {
    name: "plain email",
    field: "prompt",
    text: "Email the creator at john.smith@gmail.com for help.",
    mustCatch: ["john.smith@gmail.com"],
  },
  {
    name: "email with subdomain + plus tag",
    field: "description",
    text: "Contact a_b+tag@mail.sub.domain.co.uk anytime.",
    mustCatch: ["a_b+tag@mail.sub.domain.co.uk"],
  },
  // --- SSN ---
  {
    name: "US SSN",
    field: "prompt",
    text: "The applicant SSN is 123-45-6789 on file.",
    mustCatch: ["123-45-6789"],
  },
  // --- phone ---
  {
    name: "US phone +country with parens",
    field: "prompt",
    text: "Reach me at +1 (415) 555-2671 during work hours.",
    mustCatch: ["+1 (415) 555-2671"],
  },
  {
    name: "US phone dashed",
    field: "description",
    text: "Support line: 415-555-2671.",
    mustCatch: ["415-555-2671"],
  },
  {
    name: "intl phone spaced",
    field: "prompt",
    text: "London office +44 20 7946 0958 is open now.",
    mustCatch: ["+44 20 7946 0958"],
  },
  // --- credit card (Luhn-valid test numbers) ---
  {
    name: "visa test card spaced",
    field: "prompt",
    text: "Charge card 4111 1111 1111 1111 monthly.",
    mustCatch: ["4111 1111 1111 1111"],
  },
  {
    name: "mastercard test card dashed",
    field: "description",
    text: "Card on file: 5555-5555-5555-4444.",
    mustCatch: ["5555-5555-5555-4444"],
  },
];

describe("deterministic PII recall floor", () => {
  test.each(FIXTURES)("catches structured PII: $name", (fx) => {
    const found = new Set(
      detectStructuredPii({ [fx.field]: fx.text }).map((f) => f.text),
    );
    for (const span of fx.mustCatch) {
      expect(found).toContain(span);
    }
  });

  test("100% recall across the whole fixture set", () => {
    let expected = 0;
    let caught = 0;
    const misses: string[] = [];
    for (const fx of FIXTURES) {
      const found = new Set(
        detectStructuredPii({ [fx.field]: fx.text }).map((f) => f.text),
      );
      for (const span of fx.mustCatch) {
        expected += 1;
        if (found.has(span)) caught += 1;
        else misses.push(`${fx.name}: ${span}`);
      }
    }
    // A privacy control's value IS its recall — assert zero misses on the
    // structured set. If this fails, that PII would persist unredacted.
    expect({ recall: caught / expected, misses }).toEqual({
      recall: 1,
      misses: [],
    });
  });

  test("does not flag a Luhn-invalid long digit run as a card", () => {
    // 16 digits but fails Luhn — an order/reference number, not a card.
    const found = detectStructuredPii({
      prompt: "Reference 1234 5678 9012 3456 for your order.",
    });
    expect(found.some((f) => f.type === "credit card")).toBe(false);
  });

  test("does not flag a bare integer run as a phone", () => {
    // No separators → an id/count, not a formatted phone.
    const found = detectStructuredPii({
      prompt: "We processed 1234567890 records overnight.",
    });
    expect(found.some((f) => f.type === "phone")).toBe(false);
  });

  test("clean marketing copy yields no structured findings", () => {
    const found = detectStructuredPii({
      description: "A friendly assistant that helps you plan weekend trips.",
      prompt: "Suggest three itineraries and a budget breakdown.",
    });
    expect(found).toHaveLength(0);
  });

  test("agentName is never scanned (it seeds the slug)", () => {
    const found = detectStructuredPii({
      agentName: "john.smith@gmail.com",
      prompt: "clean prompt",
    });
    expect(found).toHaveLength(0);
  });
});
