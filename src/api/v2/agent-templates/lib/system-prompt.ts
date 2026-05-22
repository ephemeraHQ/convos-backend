import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { logError } from "@/utils/errors";

/**
 * System prompt loaded once at module init.
 * convos-backend owns this prompt; it originated as a copy of pool's
 * skill-generator-prompt.txt, but pool is decommissioned and this file is
 * now the source of truth — edit it here.
 *
 * Path is resolved relative to THIS module via `import.meta.url` so the
 * lookup works regardless of the directory the Node process was started
 * from. (Previously used `resolve("data/template-generator-prompt.txt")`
 * which only worked when cwd was the repo root.)
 *
 * If readFileSync throws at import time (file missing, unreadable, etc.),
 * the module does not crash — SYSTEM_PROMPT is set to null and downstream
 * handlers should return 502 referencing the missing prompt.
 */
let SYSTEM_PROMPT: string | null = null;

// __dirname for ESM. This file lives at src/api/v2/agent-templates/lib/,
// so the repo root is 5 levels up.
const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPT_PATH = join(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "..",
  "data",
  "template-generator-prompt.txt",
);

try {
  SYSTEM_PROMPT = readFileSync(PROMPT_PATH, "utf8").trim();
} catch (err) {
  // Intentionally swallowed: module must not crash on import.
  // Downstream handlers check for null and return 502.
  // Log the failure so deployment misconfigurations are diagnosable.
  logError(err, {
    context: "system-prompt",
    message: `Failed to load ${PROMPT_PATH}`,
  });
}

export { SYSTEM_PROMPT };
