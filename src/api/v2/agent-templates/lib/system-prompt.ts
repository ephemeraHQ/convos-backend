import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * System prompt loaded once at module init.
 * The prompt file is a verbatim copy of pool/data/skill-generator-prompt.txt.
 *
 * If readFileSync throws at import time (file missing, unreadable, etc.),
 * the module does not crash — SYSTEM_PROMPT is set to null and downstream
 * handlers should return 502 referencing the missing prompt.
 */
let SYSTEM_PROMPT: string | null = null;

try {
  SYSTEM_PROMPT = readFileSync(
    resolve("data/template-generator-prompt.txt"),
    "utf8",
  ).trim();
} catch (err) {
  // Intentionally swallowed: module must not crash on import.
  // Downstream handlers check for null and return 502.
  // Log the failure so deployment misconfigurations are diagnosable.
  console.error(
    "[system-prompt] Failed to load data/template-generator-prompt.txt:",
    err instanceof Error ? err.message : err,
  );
}

export { SYSTEM_PROMPT };
