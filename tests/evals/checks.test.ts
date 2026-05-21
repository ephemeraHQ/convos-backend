/**
 * Offline unit tests for the deterministic gate. No network, no app imports —
 * keeps the harness's own logic regression-covered and runnable in CI via
 * `bun test`.
 */

import { describe, expect, test } from "vitest";
import { runGate } from "./lib/checks";
import type { GeneratedTemplateLite } from "./lib/types";

const GOOD: GeneratedTemplateLite = {
  agentName: "Ledger",
  emoji: "🧾",
  description:
    "Keeps a running tally of group expenses and ships a settlement plan.",
  category: "Money & Investing",
  tools: ["Search", "Schedule"],
  prompt: [
    "Character: Ledger 🧾",
    "",
    "## BRAIN — How You Think",
    "Primary Job: keep a clean tally of who paid for what.",
    ...Array.from(
      { length: 60 },
      (_u, i) => `Detail line ${i} about decision logic, memory, triggers.`,
    ),
    "",
    "## WELCOME MESSAGE",
    "\"Hey, I'm Ledger 🧾 — I keep tabs so nobody has to. I'm putting together a starter ledger card now — give me a sec.\"",
    "",
    "---",
    "",
    "## Runtime Reminder",
    "Chat replies are push notifications. Hard cap: 3 sentences, plain text.",
  ].join("\n"),
};

describe("runGate", () => {
  test("passes a well-formed template", () => {
    const gate = runGate(GOOD);
    expect(gate.passed).toBe(gate.total);
  });

  test("flags an invalid tool", () => {
    const gate = runGate({ ...GOOD, tools: ["Search", "Telekinesis"] });
    expect(gate.checks.tools_valid).toBe(false);
  });

  test("flags an off-taxonomy category", () => {
    const gate = runGate({ ...GOOD, category: "Crypto Bro Stuff" });
    expect(gate.checks.category_valid).toBe(false);
  });

  test("flags a generic name", () => {
    const gate = runGate({ ...GOOD, agentName: "Assistant" });
    expect(gate.checks.name_not_generic).toBe(false);
  });

  test("flags a missing Character line", () => {
    const gate = runGate({
      ...GOOD,
      prompt: GOOD.prompt.replace("Character: Ledger 🧾", "Ledger the agent"),
    });
    expect(gate.checks.character_line_present).toBe(false);
  });

  test("flags a missing welcome message", () => {
    const gate = runGate({
      ...GOOD,
      prompt: GOOD.prompt.replace(/## WELCOME MESSAGE[\s\S]*?"\n/, ""),
    });
    expect(gate.checks.welcome_present).toBe(false);
  });

  test("excludes the appended brevity rail from the word count", () => {
    // A short authored body + a long rail should still fail the word floor,
    // proving the rail isn't counted toward the authored length.
    const tiny: GeneratedTemplateLite = {
      ...GOOD,
      prompt: [
        "Character: Tiny 🐭",
        "Too short to be a real prompt.",
        "---",
        "## Runtime Reminder",
        ...Array.from({ length: 300 }, () => "rail filler word"),
      ].join("\n"),
    };
    expect(runGate(tiny).checks.word_count_reasonable).toBe(false);
  });
});
