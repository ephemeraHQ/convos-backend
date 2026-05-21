/**
 * Generation adapter — drives the REAL template generation pipeline
 * (templateGen.ts → openrouter-client.ts) so the eval measures what production
 * actually ships: the playbook system prompt, the strict json_schema, the
 * appended brevity rail, soft defaults, and the empty-prompt rejection gate.
 *
 * Two concerns this file handles:
 *
 * 1. Config bootstrap. templateGen.ts imports @/config, which validates a set of
 *    env vars at module load (tests/setup.ts seeds them for `pnpm test`, but
 *    this harness runs under plain `pnpm tsx`). We set the config-required
 *    placeholders BEFORE the dynamic import. We deliberately do NOT set
 *    BUILDER_OPENROUTER_API_KEY (must be a real key from the environment) or
 *    POSTHOG_PROJECT_TOKEN (left unset so eval generations never pollute product
 *    LLM-analytics traces).
 *
 * 2. Model selection. The only seam is the process-global
 *    __setBuilderModelOverrideForTests. Concurrent generations of different
 *    models would race it, so every generateTemplate call is serialized through
 *    a promise chain: (set override → generate) runs atomically. Generation is
 *    the slow LLM call; judging (which has no global state) still parallelizes.
 */

import type * as TemplateGenModule from "../../../src/api/v2/agent-templates/services/templateGen";
import { withRetry } from "./retry";
import type { GeneratedTemplateLite, GenMetrics } from "./types";

function setDefault(key: string, value: string): void {
  if (!process.env[key]) process.env[key] = value;
}

let bootstrapped = false;
function bootstrapEnv(): void {
  if (bootstrapped) return;
  // Mirror the config-required subset of tests/preload.ts.
  setDefault("XMTP_NOTIFICATION_SECRET", "eval-placeholder-secret");
  setDefault("NOTIFICATION_SERVER_URL", "http://localhost:8080");
  setDefault("ASSISTANT_API_URL", "https://assistants.test.local");
  setDefault("SIWE_DOMAIN", "convos.app");
  setDefault("SIWE_URI", "https://convos.app");
  setDefault("NONCE_HMAC_SECRET", "0".repeat(64));
  setDefault("SIWE_ALLOWED_CHAIN_IDS", "1");
  setDefault("BUILDER_SITE_URL", "https://dev.convos.org");
  bootstrapped = true;
}

let modPromise: Promise<typeof TemplateGenModule> | null = null;
function loadTemplateGen(): Promise<typeof TemplateGenModule> {
  if (!modPromise) {
    bootstrapEnv();
    modPromise = (async () => {
      const tg =
        await import("../../../src/api/v2/agent-templates/services/templateGen");
      // Generation reads BUILDER_OPENROUTER_API_KEY (the production var). When
      // it's unset but EVAL_OPENROUTER_API_KEY is, drive generation from the
      // eval key too, so a single key powers both generation and the judge.
      const evalKey = process.env.EVAL_OPENROUTER_API_KEY?.trim();
      if (!process.env.BUILDER_OPENROUTER_API_KEY?.trim() && evalKey) {
        tg.__setBuilderApiKeyOverrideForTests(evalKey);
      }
      return tg;
    })();
  }
  return modPromise;
}

export interface GenerationResult {
  template: GeneratedTemplateLite;
  metrics: GenMetrics;
}

// Serialize all generations: the model override is process-global.
let chain: Promise<unknown> = Promise.resolve();

/**
 * Generate a template for `input` using `model`, via the real pipeline.
 * Pass `systemPrompt` to A/B a specific generator prompt (e.g. base-branch vs PR
 * version); omit it to use the loaded data/template-generator-prompt.txt.
 *
 * Serialized against every other call so the global model + prompt overrides are
 * safe under concurrency. Rejects if generation fails (caller records it).
 */
export function generateForModel(
  input: string,
  model: string,
  systemPrompt?: string,
): Promise<GenerationResult> {
  const run = chain.then(async () => {
    const tg = await loadTemplateGen();
    tg.__setBuilderModelOverrideForTests(model);
    // null restores the loaded prompt, so model-only runs are unaffected.
    tg.__setSystemPromptOverrideForTests(systemPrompt ?? null);
    // Retry transient throttles (429) / 5xx. Runs inside the serialized chain,
    // so the backoff also re-paces the queue and prevents a 429 cascade.
    const { template, metrics } = await withRetry(
      () => tg.generateTemplate({ text: input }),
      {
        onRetry: (err, attempt, delayMs) => {
          console.warn(
            `  ↻ generate retry ${attempt} [${model}] in ${Math.round(delayMs)}ms: ${String(err)}`,
          );
        },
      },
    );
    // connections is always server-injected as []; drop it from the eval view.
    const { connections: _connections, ...lite } = template;
    return { template: lite, metrics };
  });
  // Keep the chain alive whether this run resolves or rejects.
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** Clear the model + system-prompt overrides (call once at the end of a run). */
export async function clearModelOverride(): Promise<void> {
  const tg = await loadTemplateGen();
  tg.__setBuilderModelOverrideForTests(null);
  tg.__setSystemPromptOverrideForTests(null);
}
