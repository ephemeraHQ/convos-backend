import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { logError } from "@/utils/errors";

/**
 * System prompt loaded once at module init.
 * The prompt file is a verbatim copy of pool/data/skill-generator-prompt.txt.
 *
 * Path is resolved by walking up from this module's directory until a
 * package.json is found (= repo root), then joining "data/template-generator-prompt.txt".
 *
 * This approach works in both modes:
 *   - tsx watch (source): __dirname = .../src/api/v2/agent-templates/lib/ → walks 5 levels to repo root
 *   - bundled (dist/index.js): __dirname = .../dist/ → walks 1 level to repo root
 * The old 5x ".." construction was correct only in source mode; in bundled mode it
 * escaped the repo entirely, causing readFileSync to fail silently and SYSTEM_PROMPT
 * to be null in production (502 on all template-generation endpoints).
 *
 * If readFileSync throws at import time (file missing, unreadable, etc.),
 * the module does not crash — SYSTEM_PROMPT is set to null and downstream
 * handlers should return 502 referencing the missing prompt.
 */
let SYSTEM_PROMPT: string | null = null;

function findRepoRoot(start: string): string {
  let dir = start;
  while (!existsSync(join(dir, "package.json"))) {
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(`Could not find repo root from ${start}`);
    }
    dir = parent;
  }
  return dir;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
// Initialize PROMPT_PATH to a best-effort relative path so the catch handler
// always has something readable to log even if findRepoRoot() itself throws
// (e.g. import-time chroot, no package.json above this module).
let PROMPT_PATH = "data/template-generator-prompt.txt";

try {
  const repoRoot = findRepoRoot(__dirname);
  PROMPT_PATH = join(repoRoot, "data", "template-generator-prompt.txt");
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
