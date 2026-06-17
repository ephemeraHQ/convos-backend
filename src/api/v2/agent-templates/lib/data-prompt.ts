import { readFileSync } from "node:fs";
import { findPackageJSON } from "node:module";
import { dirname, join } from "node:path";
import { logError } from "@/utils/errors";

/**
 * Load a text asset from the repo's top-level `data/` directory once, at call
 * time. Returns the trimmed contents, or `null` when anything in the resolution
 * chain throws — callers must handle null (e.g. return 502, or skip the stage).
 *
 * Repo root is resolved via Node's `findPackageJSON` (`node:module`), which
 * walks up from this module's URL until it finds a package.json. That works in
 * both modes the server runs in:
 *   - tsx watch (source): walks from src/api/v2/agent-templates/lib/ → repo root
 *   - bundled (dist/index.js): walks from dist/ → repo root
 * A naive relative ".." chain is correct only in source mode; in bundled mode
 * it escapes the repo and readFileSync fails silently — the production 502 that
 * motivated centralising this resolution here.
 */
export function loadDataPrompt(filename: string): string | null {
  // Best-effort relative path so the catch handler always has something
  // readable to log even if findPackageJSON itself throws.
  let promptPath = join("data", filename);
  try {
    const pkgJson = findPackageJSON(".", import.meta.url);
    if (!pkgJson) {
      throw new Error(
        `findPackageJSON returned undefined for ${import.meta.url}`,
      );
    }
    promptPath = join(dirname(pkgJson), "data", filename);
    return readFileSync(promptPath, "utf8").trim();
  } catch (err) {
    // Intentionally swallowed: module init must not crash on import.
    // Log so deployment misconfigurations are diagnosable.
    logError(err, {
      context: "data-prompt",
      message: `Failed to load ${promptPath}`,
    });
    return null;
  }
}
