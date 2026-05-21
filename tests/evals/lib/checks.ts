/**
 * Deterministic gate checks — model-agnostic, no network. These catch structural
 * failures for free so the LLM judge can focus on quality. `generateTemplate`
 * already throws on missing agentName/prompt, so by the time a template reaches
 * here those exist; the gate covers the closed-set and format constraints the
 * playbook imposes (tools, category, naming, welcome, length).
 *
 * Kept import-light (no app/config imports) so it stays unit-testable offline.
 */

import { ALLOWED_TOOLS, CATEGORIES } from "./rubric";
import type { GateResult, GeneratedTemplateLite } from "./types";

/** Marker that begins the BREVITY_RAIL block templateGen appends to every
 *  prompt. Stripped before length/character-line checks so we measure only the
 *  model-authored portion. Keep in sync with BREVITY_RAIL in templateGen.ts. */
const RAIL_MARKER = "## Runtime Reminder";

const GENERIC_NAMES = new Set(["assistant", "helper", "bot", "ai", "agent"]);

/** The model-authored prompt, minus the server-appended brevity rail. */
function authoredPrompt(prompt: string): string {
  const i = prompt.indexOf(RAIL_MARKER);
  return (i === -1 ? prompt : prompt.slice(0, i)).trim();
}

function firstNonEmptyLine(text: string): string {
  for (const line of text.split("\n")) {
    if (line.trim()) return line.trim();
  }
  return "";
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

export function runGate(t: GeneratedTemplateLite): GateResult {
  const authored = authoredPrompt(t.prompt);
  const charLine = firstNonEmptyLine(authored);
  const words = wordCount(authored);

  const checks: Record<string, boolean> = {
    // SUPERPOWERS: tools come only from the closed set, and at least one.
    tools_valid:
      t.tools.length > 0 &&
      t.tools.every((tool) =>
        (ALLOWED_TOOLS as readonly string[]).includes(tool),
      ),
    // category from the closed taxonomy.
    category_valid: (CATEGORIES as readonly string[]).includes(t.category),
    // Naming rules: a 1-3 word handle, never a generic placeholder.
    name_not_generic:
      t.agentName.trim().length > 0 &&
      !GENERIC_NAMES.has(t.agentName.trim().toLowerCase()) &&
      t.agentName.trim().split(/\s+/).length <= 3,
    // First line of the prompt is the `Character:` identity line.
    character_line_present: /^character:/i.test(charLine),
    // agentName appears on that Character line (the single identity).
    name_in_character_line: charLine
      .toLowerCase()
      .includes(t.agentName.trim().toLowerCase()),
    emoji_present: t.emoji.trim().length > 0,
    // THE ENTRANCE: a WELCOME MESSAGE label with a double-quoted greeting.
    welcome_present:
      /welcome message/i.test(authored) && /"[^"]{10,}"/.test(authored),
    // Field requirements: ~800 words, hard ceiling ~1000 (allow slack to 1100).
    word_count_reasonable: words >= 250 && words <= 1100,
  };

  const values = Object.values(checks);
  return {
    checks,
    passed: values.filter(Boolean).length,
    total: values.length,
  };
}
