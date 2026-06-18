import { loadDataPrompt } from "./data-prompt";

/**
 * System prompt loaded once at module init.
 * convos-backend owns this prompt; it originated as a copy of pool's
 * skill-generator-prompt.txt, but pool is decommissioned and this file
 * (data/template-generator-prompt.txt) is now the source of truth — edit it
 * here.
 *
 * `null` when the file can't be read; downstream handlers check for null and
 * return 502 referencing the missing prompt. The bundled-vs-source path
 * resolution lives in `loadDataPrompt`.
 */
const SYSTEM_PROMPT = loadDataPrompt("template-generator-prompt.txt");

export { SYSTEM_PROMPT };
