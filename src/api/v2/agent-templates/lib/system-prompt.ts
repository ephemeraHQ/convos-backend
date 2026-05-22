import { readFileSync } from "node:fs";
import { findPackageJSON } from "node:module";
import { dirname, join } from "node:path";
import { logError } from "@/utils/errors";

/**
 * System prompt loaded once at module init.
 * The prompt file is a verbatim copy of pool/data/skill-generator-prompt.txt.
 *
 * Repo root is resolved via Node 24's `findPackageJSON` from `node:module`,
 * which walks up from this module's URL until it finds a package.json. That
 * works in both modes the server runs in:
 *   - tsx watch (source): walks from src/api/v2/agent-templates/lib/ → repo root
 *   - bundled (dist/index.js): walks from dist/ → repo root
 * The old 5x ".." construction was correct only in source mode; in bundled
 * mode it escaped the repo entirely, causing readFileSync to fail silently
 * and SYSTEM_PROMPT to be null in production (502 on all template-generation
 * endpoints).
 *
 * If anything in this chain throws at import time, the module does not
 * crash — SYSTEM_PROMPT is set to null and downstream handlers should
 * return 502 referencing the missing prompt.
 */
let SYSTEM_PROMPT: string | null = null;

// Initialize PROMPT_PATH to a best-effort relative path so the catch handler
// always has something readable to log even if findPackageJSON itself throws
// (e.g. import-time chroot, no package.json above this module).
let PROMPT_PATH = "data/template-generator-prompt.txt";

try {
  const pkgJson = findPackageJSON(".", import.meta.url);
  if (!pkgJson) {
    throw new Error(
      `findPackageJSON returned undefined for ${import.meta.url}`,
    );
  }
  const repoRoot = dirname(pkgJson);
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
