/**
 * Passthrough-classifier eval (Braintrust SDK, run under tsx).
 *
 * Answers: when a user pastes content, do we use it VERBATIM as the agent prompt
 * (passthrough) or DESIGN an agent from it? A real prod build (golf "Caddie")
 * pasted a third-person BRIEF and #265's "Lean PASSTHROUGH" classifier tagged it
 * skill-definition, so no agent was designed and an undeliverable booking
 * capability shipped. This eval scores classifier VARIANTS on a labeled dataset
 * (the Caddie brief + third-person briefs + source material as expected=false;
 * genuine agent-addressed prompts + install steps as expected=true) so we can
 * pick the approach empirically instead of guessing.
 *
 * Variants (frozen prompt snapshots taken verbatim from git history):
 *   pre265    — the classifier prompt BEFORE #265 ("Two kinds of content count
 *               as passthrough" / "Anything else is source material → false").
 *               The stricter version, no "Lean PASSTHROUGH" bias. From 5cd1529^.
 *   post265   — the classifier prompt AFTER #265 ("Choose PASSTHROUGH … whenever
 *               the content is AGENT-SHAPED" + "Lean PASSTHROUGH …"). The loosened
 *               version that shipped the Caddie bug. Decision text is byte-identical
 *               to what was live on otr-dev before this PR (verified).
 *   current   — the SHIPPED production path (classifyPastedContent): deterministic
 *               structure gate → passthrough, else the improved LLM prompt. This
 *               is the hybrid the PR ships; the `current` column is the real fix.
 *   heuristic — the deterministic gate ALONE (detectStructuredSkillDefinition):
 *               structure → passthrough, no LLM. Shows why the gate can't stand
 *               alone (it mis-designs unstructured prompts).
 *
 * Usage:
 *   BRAINTRUST_API_KEY=...  BUILDER_OPENROUTER_API_KEY=...  \
 *   pnpm tsx tests/evals/classifier.ts \
 *     --variants pre265,post265,current,heuristic \
 *     --model minimax/minimax-m3 --samples 5
 *
 * BRAINTRUST_API_KEY is optional — without it, the console summary still prints
 * (Braintrust logging is skipped). At least one OpenRouter key is required for
 * the LLM variants (BUILDER_OPENROUTER_API_KEY, or EVAL_OPENROUTER_API_KEY).
 */

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-non-null-assertion */

import { parseArgs } from "node:util";
import * as braintrust from "braintrust";
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
    project: { type: "string" },
    concurrency: { type: "string" },
  },
});

const ALL_VARIANTS = [
  "pre265",
  "post265",
  "addressed-only",
  "completeness-only",
  "current",
  "heuristic",
] as const;
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
  values.model ?? process.env.BUILDER_CLASSIFIER_MODEL ?? "minimax/minimax-m3";
const SAMPLES = Math.max(
  1,
  Number(values.samples ?? process.env.EVAL_SAMPLES ?? 3),
);
const DATASET =
  values.dataset ??
  process.env.EVAL_DATASET ??
  "tests/evals/datasets/classifier.jsonl";
const PROJECT =
  values.project ?? process.env.EVAL_PROJECT ?? "convos-builder-classifier";
const CONCURRENCY = Math.max(1, Number(values.concurrency ?? 6));

interface ClassifierCase extends EvalCase {
  expected: boolean;
}

// ---------------------------------------------------------------------------
// Env bootstrap (mirror lib/generate.ts) — @/config validates at import time.
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
// Frozen classifier-prompt snapshots from git history. Decision text is copied
// verbatim; only the trailing JSON spec is trimmed to {isPassthrough} since the
// eval scores the verdict, not the metadata extraction.
// ---------------------------------------------------------------------------

// PRE-#265 — the stricter prompt (parent of 5cd1529). No "Lean PASSTHROUGH".
function pre265ClassifierPrompt(content: string): string {
  return `You are classifying pasted text to decide if it should be used VERBATIM as the prompt for a new AI agent, or treated as source material to design an agent from.

Pasted content:
---
${content}
---

Two kinds of content count as "passthrough" (use verbatim, do not re-generate):

Type A — install-instructions: setup choreography addressed to an AI agent
- Second-person language: "Read this, then follow the steps", "Ask the user for API keys"
- Setup commands: git clone, npm install, bun install, export env vars
- Agent workflow: clone → install → configure → adopt skills → report progress
- Clearly addressed to an AI, not to a human developer

Type B — skill-definition: a complete system prompt already written for an agent
- Often has YAML frontmatter with name: and description:
- Direct instructions to an AI: "You are...", "You must...", "Your job is to..."
- Section headers like BRAIN/SOUL/HEART, or THE HOOK, or rules/behavior definitions
- A ready-to-use agent definition, not content ABOUT a topic

Anything else is "source material" — an article, essay, README-for-humans, product spec, book excerpt, etc. — and should NOT be passthrough. For those, return false.

Respond with ONLY a JSON object (no markdown fences, no explanation):

{
  "isPassthrough": true|false
}`;
}

// POST-#265 — the loosened prompt that shipped the Caddie bug (5cd1529). The
// decision text below is byte-identical to what was live on otr-dev pre-PR.
function post265ClassifierPrompt(content: string): string {
  return `You are classifying pasted text to decide if it should be used VERBATIM as the prompt for a new AI agent, or treated as source material to design an agent from.

Pasted content:
---
${content}
---

Choose PASSTHROUGH (use the text verbatim, do not re-generate) whenever the content is AGENT-SHAPED — i.e. it reads like instructions written FOR an AI agent rather than prose written for a human reader. Two common shapes:

Type A — install-instructions: setup choreography addressed to an AI agent
- Second-person language: "Read this, then follow the steps", "Ask the user for API keys"
- Setup commands: git clone, npm install, bun install, export env vars
- Agent workflow: clone → install → configure → adopt skills → report progress
- Addressed to an AI, not (only) to a human developer

Type B — skill-definition: a system prompt / agent definition already written for an agent
- YAML frontmatter with name:/description:, or a title plus a role/identity line
- Direct instructions to an AI: "You are...", "You must...", "Your job is to...", "Always/Never..."
- A defined persona, voice, or behavioral rules; section headers like BRAIN/SOUL/HEART, THE HOOK, GUIDELINES, RULES, TONE, WELCOME MESSAGE
- A ready-to-run agent definition — even a rough, partial, or unconventional one — rather than an article ABOUT a topic

Lean PASSTHROUGH. If the text is structured as an agent persona, behavioral brief, or instruction set — even if it's imperfect, incomplete, or you would have written it differently — classify it as passthrough and preserve the author's wording. The author already wrote a prompt; respect it instead of rewriting it.

Return false ONLY for genuine SOURCE MATERIAL — text written for humans that an agent would have to be DESIGNED from rather than run on directly: an article, essay, news story, README-for-humans, marketing/landing copy, product spec, or book/transcript excerpt, with no instructions addressed to an agent.

Respond with ONLY a JSON object (no markdown fences, no explanation):

{
  "isPassthrough": true|false
}`;
}

// ABLATION — addressed-to axis ONLY (no completeness route). Mirrors the first
// version of this PR's fix. Expected to fail the Pickler (long third-person spec).
function addressedOnlyClassifierPrompt(content: string): string {
  return `You are classifying pasted text: use it VERBATIM as the agent's prompt (passthrough), or design an agent from it (design)?

Pasted content:
---
${content}
---

PASSTHROUGH (isPassthrough true) — the text is ADDRESSED TO an AI agent: a system prompt or instructions written to the agent ("You are…", "You must…", "Always/Never…", YAML frontmatter), or install/setup steps addressed to an AI (git clone, npm install, "ask the user for API keys"). The decisive test is who the text speaks to.

DESIGN (isPassthrough false) — anything written for a human reader, EVEN WHEN it precisely describes the agent: a third-person brief/description ("Coordinates…", "Helps…", "Sends reminders. Friendly personality."), or an article / essay / news / README / marketing / product-spec / book excerpt. Describing what the agent does is not the same as addressing the agent.

Respond with ONLY a JSON object (no markdown fences): { "isPassthrough": true|false }`;
}

// ABLATION — completeness axis ONLY (no addressed-to route), HARDENED for depth
// vs breadth. Tests whether a well-worded completeness signal alone can hold the
// short-brief line (which the un-hardened version failed: it read a terse feature
// list that NAMED every facet as "complete").
function completenessOnlyClassifierPrompt(content: string): string {
  return `You are classifying pasted text: use it VERBATIM as the agent's prompt (passthrough), or design an agent from it (design)?

Pasted content:
---
${content}
---

PASSTHROUGH (isPassthrough true) — the text is a COMPLETE agent specification: it SPECIFIES the agent across multiple sections — objective/goal, concrete mechanics (state it tracks, triggers, the step-by-step actions/loops it runs), behavior/rules, voice/persona, and scope — developed enough to run on as-is. The bar is DEPTH, not breadth: it must specify HOW each part works (the concrete rules, exact triggers, step-by-step loop), not merely NAME the capabilities. It may be written in any grammatical person.

DESIGN (isPassthrough false) — raw material to design from:
- A SHORT brief or idea: a few sentences or a feature LIST that NAMES what the agent should do without specifying HOW each part works. A terse line that names an objective, several features, and a persona is still a brief — naming every facet is breadth, not depth. ("Coordinates tee times, polls the group, manages RSVPs, sends reminders. Friendly golf-buddy personality." names five things and specifies none → design.)
- Human prose not authored as an agent definition: article, essay, news, README-for-humans, marketing copy, product spec for people, or book/transcript excerpt — at any length.

Respond with ONLY a JSON object (no markdown fences): { "isPassthrough": true|false }`;
}

// Robust isPassthrough extraction (mirrors classifyPastedContent's parse).
function parseVerdict(raw: string | null | undefined): boolean | null {
  if (!raw) return null;
  const tryParse = (s: string): boolean | null => {
    try {
      const o = JSON.parse(s) as { isPassthrough?: unknown };
      return typeof o.isPassthrough === "boolean" ? o.isPassthrough : null;
    } catch {
      return null;
    }
  };
  const cleaned = raw
    .replace(/^```json?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  const direct = tryParse(cleaned);
  if (direct !== null) return direct;
  const match = cleaned.match(/\{[\s\S]*"isPassthrough"[\s\S]*\}/);
  return match ? tryParse(match[0]) : null;
}

// ---------------------------------------------------------------------------
// Variant runners → each returns the isPassthrough verdict (or null on failure)
// ---------------------------------------------------------------------------
let _tg: any = null;
let _client: any = null;
async function loadDeps(): Promise<void> {
  if (_tg) return;
  _tg = await import("../../src/api/v2/agent-templates/services/templateGen");
  _client =
    await import("../../src/api/v2/agent-templates/services/openrouter-client");
  if (OPENROUTER_KEY) _tg.__setBuilderApiKeyOverrideForTests(OPENROUTER_KEY);
  _tg.__setClassifierModelOverrideForTests(MODEL);
}

async function runCurrent(input: string): Promise<boolean | null> {
  await loadDeps();
  const res = await _tg.classifyPastedContent(input);
  return res ? Boolean(res.classification?.isPassthrough) : null;
}

async function runLlmPrompt(prompt: string): Promise<boolean | null> {
  await loadDeps();
  const resp = await _client.openRouterChatCompletion({
    apiKey: OPENROUTER_KEY,
    stage: "classifier",
    body: {
      model: MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2,
    },
  });
  return parseVerdict(resp?.choices?.[0]?.message?.content);
}

async function runHeuristic(input: string): Promise<boolean> {
  await loadDeps();
  // The exact production deterministic gate — structure ⇒ passthrough, no LLM.
  return Boolean(_tg.detectStructuredSkillDefinition(input));
}

async function runVariant(v: Variant, input: string): Promise<boolean | null> {
  switch (v) {
    case "pre265":
      return runLlmPrompt(pre265ClassifierPrompt(input));
    case "post265":
      return runLlmPrompt(post265ClassifierPrompt(input));
    case "addressed-only":
      return runLlmPrompt(addressedOnlyClassifierPrompt(input));
    case "completeness-only":
      return runLlmPrompt(completenessOnlyClassifierPrompt(input));
    case "current":
      return runCurrent(input);
    case "heuristic":
      return runHeuristic(input);
  }
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const cases = loadCases(DATASET) as ClassifierCase[];
  for (const c of cases) {
    if (typeof (c as any).expected !== "boolean") {
      throw new Error(`Case "${c.id}" is missing a boolean \`expected\` field`);
    }
  }
  const needsLlm = VARIANTS.some((v) => v !== "heuristic");
  if (needsLlm && !OPENROUTER_KEY) {
    throw new Error(
      "No OpenRouter key — set BUILDER_OPENROUTER_API_KEY or EVAL_OPENROUTER_API_KEY (or run --variants heuristic).",
    );
  }
  const useBraintrust = Boolean(process.env.BRAINTRUST_API_KEY);

  const runs = cases.flatMap((c) =>
    Array.from({ length: SAMPLES }, (_u, sample) => ({ c, sample })),
  );

  // variant → caseId → correct-sample-count (for the summary table)
  const tally = new Map<Variant, Map<string, number>>();

  for (const variant of VARIANTS) {
    tally.set(variant, new Map());
    const experiment = useBraintrust
      ? braintrust.init(PROJECT, {
          experiment: `classifier-${variant}-${MODEL.replace(/[^a-z0-9]+/gi, "-")}`,
          metadata: {
            variant,
            model: MODEL,
            dataset: DATASET,
            samples: SAMPLES,
          },
        })
      : null;
    console.log(`\n▶ ${variant} (${MODEL}, ${runs.length} runs)…`);

    await mapLimit(runs, CONCURRENCY, async ({ c, sample }) => {
      let verdict: boolean | null = null;
      let error: string | undefined;
      try {
        verdict = await runVariant(variant, c.input);
      } catch (err) {
        error = String(err);
        console.error(`  ✗ ${variant} · ${c.id}: ${error}`);
      }
      const correct = verdict === c.expected ? 1 : 0;
      if (verdict !== null) {
        tally
          .get(variant)!
          .set(c.id, (tally.get(variant)!.get(c.id) ?? 0) + correct);
      }
      experiment?.log({
        input: c.input,
        output: { isPassthrough: verdict },
        expected: { isPassthrough: c.expected },
        error,
        scores: { correct },
        metadata: { caseId: c.id, variant, model: MODEL, sample },
      });
    });

    if (experiment) {
      await experiment.flush();
      console.log(await experiment.summarize());
    }
  }

  // Console summary: majority verdict per case, accuracy per variant.
  const majority = (variant: Variant, c: ClassifierCase): string => {
    const correctCount = tally.get(variant)!.get(c.id) ?? 0;
    const verdictIsExpected = correctCount * 2 >= SAMPLES; // majority correct
    const got = verdictIsExpected ? c.expected : !c.expected;
    return `${got ? "passthrough" : "design"}${verdictIsExpected ? " ✓" : " ✗"}`;
  };
  console.log(`\n=== classifier eval — model=${MODEL}, samples=${SAMPLES} ===`);
  console.log(`case (expected)                 | ${VARIANTS.join(" | ")}`);
  for (const c of cases) {
    const exp = c.expected ? "passthrough" : "design";
    const cols = VARIANTS.map((v) => majority(v, c)).join(" | ");
    console.log(`${(c.id + " (" + exp + ")").padEnd(31)} | ${cols}`);
  }
  for (const v of VARIANTS) {
    const correctCases = cases.filter((c) => {
      const cc = tally.get(v)!.get(c.id) ?? 0;
      return cc * 2 >= SAMPLES;
    }).length;
    console.log(`accuracy ${v}: ${correctCases}/${cases.length}`);
  }

  if (_tg) {
    _tg.__setClassifierModelOverrideForTests(null);
    _tg.__setBuilderApiKeyOverrideForTests(undefined);
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
