/**
 * Twitter-intent-classifier eval (run under tsx).
 *
 * Answers: when a tweet @mentions the build bot, does the intent gate correctly
 * tell a genuine build request from a tweet that merely TALKS ABOUT / SHOWS OFF
 * an agent? A real prod build ("Encore") fired off @ShaneMac's third-person
 * showcase of an existing agent — the gate read the described features as a
 * request. This eval scores the gate on a labeled dataset (showcases /
 * announcements / spam as expected=false; genuine build requests as
 * expected=true) so the prompt is tuned empirically, not by guesswork.
 *
 * Variants:
 *   baseline — the intent prompt BEFORE this change (frozen inline). No
 *              describe-vs-request distinction; expected to build the showcases.
 *   current  — the SHIPPED gate (checkTwitterIntent) with this PR's prompt.
 *
 * Usage:
 *   BUILDER_OPENROUTER_API_KEY=...  \
 *   pnpm tsx tests/evals/twitter-intent.ts --variants baseline,current --samples 3
 *
 * An OpenRouter key is required (BUILDER_OPENROUTER_API_KEY or
 * EVAL_OPENROUTER_API_KEY); the eval calls the real classifier model. There is
 * no Braintrust dependency — the console summary is the whole report.
 */

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-non-null-assertion */

import { parseArgs } from "node:util";
import { mapLimit } from "./lib/concurrency";
import { loadCases } from "./lib/dataset";
import type { EvalCase } from "./lib/types";

// ---------------------------------------------------------------------------
// Config (flags > env > default)
// ---------------------------------------------------------------------------
const { values } = parseArgs({
  options: {
    variants: { type: "string" },
    model: { type: "string" },
    samples: { type: "string" },
    dataset: { type: "string" },
    concurrency: { type: "string" },
  },
});

const ALL_VARIANTS = ["baseline", "current"] as const;
type Variant = (typeof ALL_VARIANTS)[number];

const VARIANTS: Variant[] = (() => {
  const raw = (values.variants ?? process.env.EVAL_VARIANTS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const picked = (raw.length ? raw : ALL_VARIANTS) as Variant[];
  for (const v of picked) {
    if (!ALL_VARIANTS.includes(v)) {
      throw new Error(
        `Unknown variant "${v}". Choose from ${ALL_VARIANTS.join(", ")}`,
      );
    }
  }
  return picked;
})();
const MODEL =
  values.model ??
  process.env.CONTENT_MODERATION_MODEL ??
  "google/gemini-3.1-flash-lite";
const SAMPLES = Math.max(
  1,
  Number(values.samples ?? process.env.EVAL_SAMPLES ?? 3),
);
const DATASET =
  values.dataset ??
  process.env.EVAL_DATASET ??
  "tests/evals/datasets/twitter-intent.jsonl";
const CONCURRENCY = Math.max(1, Number(values.concurrency ?? 6));

interface IntentCase extends EvalCase {
  /** true = the tweet is a genuine agent_request. */
  expected: boolean;
}

// ---------------------------------------------------------------------------
// Env bootstrap (mirror lib/generate.ts) — @/config validates at import time,
// so set placeholders BEFORE the dynamic imports in loadDeps() below.
// ---------------------------------------------------------------------------
function setDefault(key: string, value: string): void {
  if (!process.env[key]) process.env[key] = value;
}
setDefault("XMTP_NOTIFICATION_SECRET", "eval-placeholder-secret");
setDefault("NOTIFICATION_SERVER_URL", "http://localhost:8080");
setDefault("ASSISTANT_API_URL", "https://assistants.test.local");
setDefault("SIWE_DOMAIN", "convos.app");
setDefault("SIWE_URI", "https://convos.app");
setDefault("NONCE_HMAC_SECRET", "0".repeat(64));
setDefault("SIWE_ALLOWED_CHAIN_IDS", "1");
setDefault("BUILDER_SITE_URL", "https://dev.convos.org");

const OPENROUTER_KEY =
  process.env.BUILDER_OPENROUTER_API_KEY?.trim() ||
  process.env.EVAL_OPENROUTER_API_KEY?.trim() ||
  "";

// ---------------------------------------------------------------------------
// Frozen pre-change prompt (baseline). Verbatim from before this PR so the
// before/after is visible in one run.
// ---------------------------------------------------------------------------
function baselineIntentPrompt(input: string): string {
  return `You are an intent classifier for a Twitter bot that builds AI assistants when users @mention it with requests like "Build me a math tutor bot".

The input below has already passed a separate content-safety check; you are ONLY judging whether the user is genuinely asking the bot to BUILD AN AGENT.

Classify into exactly one of two categories:

- "agent_request": The user is requesting an AI agent / assistant / bot to be built. Examples: "Build me a math tutor", "Create a recipe assistant", "Make me a travel planner bot", "I need a bot that helps with coding".

- "not_agent_request": The content is something other than a build request. Examples: "follow me back", "retweet this", "hi", "good morning", "@bot what's up", "lol", generic greetings, requests for the bot to perform actions other than building agents.

Respond with ONLY the classification label, nothing else. No quotes, no explanation, no extra text.

Tweet text to classify:
${input}`;
}

// agent_request ⇒ true, not_agent_request ⇒ false, anything else ⇒ null (the
// real gate fails open on an odd label; here we report it as an error rather
// than scoring it as a miss).
function parseLabel(raw: string | null | undefined): boolean | null {
  const t = (raw ?? "").trim().toLowerCase();
  if (t === "agent_request") return true;
  if (t === "not_agent_request") return false;
  return null;
}

// ---------------------------------------------------------------------------
// Deps — dynamic-imported after the env bootstrap above (relative paths, since
// the tsx path-alias resolver differs for dynamic import()).
// ---------------------------------------------------------------------------
let _mod: any = null;
let _client: any = null;
async function loadDeps(): Promise<{ mod: any; client: any }> {
  if (!_mod || !_client) {
    _mod = await import("../../src/api/v2/agent-templates/services/moderation");
    _client =
      await import("../../src/api/v2/agent-templates/services/openrouter-client");
    _mod.__setBuilderApiKeyOverrideForTests(OPENROUTER_KEY);
    _mod.__setContentModelOverrideForTests(MODEL);
  }
  return { mod: _mod, client: _client };
}

async function runBaseline(input: string): Promise<boolean | null> {
  const { client } = await loadDeps();
  const resp = await client.openRouterChatCompletion({
    apiKey: OPENROUTER_KEY,
    stage: "twitter-intent",
    body: {
      model: MODEL,
      messages: [{ role: "user", content: baselineIntentPrompt(input) }],
      temperature: 0.1,
      max_tokens: 20,
    },
  });
  return parseLabel(resp.choices[0]?.message?.content);
}

async function runCurrent(input: string): Promise<boolean | null> {
  const { mod } = await loadDeps();
  const res = await mod.checkTwitterIntent(input);
  return Boolean(res.allowed);
}

async function runVariant(v: Variant, input: string): Promise<boolean | null> {
  return v === "baseline" ? runBaseline(input) : runCurrent(input);
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const cases = loadCases(DATASET) as IntentCase[];
  for (const c of cases) {
    if (typeof c.expected !== "boolean") {
      throw new Error(`Case "${c.id}" is missing a boolean \`expected\` field`);
    }
  }
  if (!OPENROUTER_KEY) {
    throw new Error(
      "No OpenRouter key — set BUILDER_OPENROUTER_API_KEY or EVAL_OPENROUTER_API_KEY.",
    );
  }

  const runs = cases.flatMap((c) =>
    Array.from({ length: SAMPLES }, (_u, sample) => ({ c, sample })),
  );

  // variant → caseId → correct-sample-count / non-null-sample-count.
  const tally = new Map<Variant, Map<string, number>>();
  const seen = new Map<Variant, Map<string, number>>();

  for (const variant of VARIANTS) {
    tally.set(variant, new Map());
    seen.set(variant, new Map());
    console.log(`\n▶ ${variant} (${MODEL}, ${runs.length} runs)…`);
    await mapLimit(runs, CONCURRENCY, async ({ c }) => {
      let verdict: boolean | null = null;
      try {
        verdict = await runVariant(variant, c.input);
      } catch (err) {
        console.error(`  ✗ ${variant} · ${c.id}: ${String(err)}`);
      }
      if (verdict !== null) {
        const correct = verdict === c.expected ? 1 : 0;
        tally
          .get(variant)!
          .set(c.id, (tally.get(variant)!.get(c.id) ?? 0) + correct);
        seen.get(variant)!.set(c.id, (seen.get(variant)!.get(c.id) ?? 0) + 1);
      }
    });
  }

  // A case is correct only when a MAJORITY of its non-null samples match; a case
  // whose every sample errored is reported as "error", never as a miss.
  const seenCount = (v: Variant, c: IntentCase) => seen.get(v)!.get(c.id) ?? 0;
  const isCorrect = (v: Variant, c: IntentCase) => {
    const n = seenCount(v, c);
    return n > 0 && (tally.get(v)!.get(c.id) ?? 0) * 2 >= n;
  };
  const cell = (v: Variant, c: IntentCase): string => {
    if (seenCount(v, c) === 0) return "error ⚠";
    const ok = isCorrect(v, c);
    const got = ok ? c.expected : !c.expected;
    return `${got ? "agent_request" : "not_agent_request"}${ok ? " ✓" : " ✗"}`;
  };

  console.log(
    `\n=== twitter-intent eval — model=${MODEL}, samples=${SAMPLES} ===`,
  );
  console.log(`case (expected)                 | ${VARIANTS.join(" | ")}`);
  for (const c of cases) {
    const exp = c.expected ? "agent_request" : "not_agent_request";
    const cols = VARIANTS.map((v) => cell(v, c)).join(" | ");
    console.log(`${(c.id + " (" + exp + ")").padEnd(31)} | ${cols}`);
  }
  for (const v of VARIANTS) {
    const correctCases = cases.filter((c) => isCorrect(v, c)).length;
    const errored = cases.filter((c) => seenCount(v, c) === 0).length;
    const errNote = errored ? ` (${errored} errored)` : "";
    console.log(`accuracy ${v}: ${correctCases}/${cases.length}${errNote}`);
  }

  if (_mod) {
    _mod.__setContentModelOverrideForTests(null);
    _mod.__setBuilderApiKeyOverrideForTests(undefined);
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
