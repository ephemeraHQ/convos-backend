/**
 * Agent-prompt eval runner (Braintrust SDK, executed under Bun).
 *
 * For each model under test, generates a template for every dataset case via the
 * real pipeline, scores it with the deterministic gate + the LLM-as-judge
 * rubric, and logs one Braintrust experiment. Optionally runs a pairwise
 * head-to-head of every other model against a baseline.
 *
 * We use the SDK's init()/log() rather than `braintrust eval` because the CLI's
 * esbuild bundler can't resolve this repo's `@/` path aliases inside
 * templateGen.ts's dependency graph; Bun resolves them natively.
 *
 * Usage:
 *   BRAINTRUST_API_KEY=...  BUILDER_OPENROUTER_API_KEY=...  \
 *   bun run tests/evals/run.ts \
 *     --models anthropic/claude-opus-4.7,google/gemini-3.1-flash-lite \
 *     --judge anthropic/claude-opus-4.7 \
 *     --dataset tests/evals/datasets/core.jsonl \
 *     --samples 1 --pairwise
 *
 * All flags also read from env (EVAL_MODELS, EVAL_JUDGE_MODEL, EVAL_DATASET,
 * EVAL_SAMPLES, EVAL_BASELINE_MODEL, EVAL_PROJECT). Flags win.
 */

import { parseArgs } from "node:util";
import * as braintrust from "braintrust";
import { runGate } from "./lib/checks";
import { mapLimit } from "./lib/concurrency";
import { loadCases } from "./lib/dataset";
import { clearModelOverride, generateForModel } from "./lib/generate";
import { judgePairwiseWinRate, judgeRubric } from "./lib/judge";
import { RUBRIC_KEYS, RUBRIC_VERSION } from "./lib/rubric";
import type { EvalCase, GeneratedTemplateLite } from "./lib/types";

// ---------------------------------------------------------------------------
// Config resolution (flags > env > default)
// ---------------------------------------------------------------------------

const { values } = parseArgs({
  options: {
    models: { type: "string" },
    judge: { type: "string" },
    dataset: { type: "string" },
    samples: { type: "string" },
    baseline: { type: "string" },
    project: { type: "string" },
    concurrency: { type: "string" },
    limit: { type: "string" },
    pairwise: { type: "boolean", default: false },
  },
});

function csv(s: string | undefined): string[] {
  return (s ?? "")
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);
}

const MODELS = (() => {
  const fromArg = csv(values.models);
  if (fromArg.length) return fromArg;
  const fromEnv = csv(process.env.EVAL_MODELS);
  return fromEnv.length
    ? fromEnv
    : ["anthropic/claude-opus-4.7", "google/gemini-3.5-flash"];
})();
const JUDGE_MODEL =
  values.judge ?? process.env.EVAL_JUDGE_MODEL ?? "openai/gpt-5.5";
const DATASET =
  values.dataset ??
  process.env.EVAL_DATASET ??
  "tests/evals/datasets/core.jsonl";
const SAMPLES = Number(values.samples ?? process.env.EVAL_SAMPLES ?? "1");
const BASELINE =
  values.baseline ?? process.env.EVAL_BASELINE_MODEL ?? MODELS[0];
const PROJECT =
  values.project ?? process.env.EVAL_PROJECT ?? "convos-agent-prompts";
const CONCURRENCY = Number(
  values.concurrency ?? process.env.EVAL_CONCURRENCY ?? "4",
);
// 0 = no limit. Cap the number of dataset cases for a quick/cheap smoke run.
const LIMIT = Number(values.limit ?? process.env.EVAL_LIMIT ?? "0");
const PAIRWISE = values.pairwise || MODELS.length > 1;

const expName = (model: string): string =>
  `${model.replace(/[^a-z0-9.-]/gi, "-")}-${new Date().toISOString().slice(0, 16)}`;

// ---------------------------------------------------------------------------
// Absolute scoring run (one Braintrust experiment per model)
// ---------------------------------------------------------------------------

interface Sampled {
  c: EvalCase;
  sample: number;
}

async function runAbsolute(cases: EvalCase[]): Promise<void> {
  const sampled: Sampled[] = cases.flatMap((c) =>
    Array.from({ length: SAMPLES }, (_unused, sample) => ({ c, sample })),
  );

  for (const model of MODELS) {
    const experiment = braintrust.init(PROJECT, {
      experiment: expName(model),
      metadata: {
        mode: "model-bakeoff",
        model,
        judgeModel: JUDGE_MODEL,
        rubricVersion: RUBRIC_VERSION,
        dataset: DATASET,
        cases: cases.length,
        samples: SAMPLES,
      },
    });
    console.log(`\n▶ scoring ${model} (${sampled.length} runs)…`);

    await mapLimit(sampled, CONCURRENCY, async ({ c, sample }) => {
      const scores: Record<string, number> = {};
      const metadata: Record<string, unknown> = {
        caseId: c.id,
        sample,
        tags: c.tags,
        model,
      };

      let template: GeneratedTemplateLite | null = null;
      // Braintrust reads token/duration columns from the reserved `metrics`
      // field (not metadata): prompt_tokens/completion_tokens/tokens, and
      // start/end (epoch seconds) → duration. These are the GENERATION model's
      // numbers — the thing under test — not the judge's eval overhead.
      let metrics: Record<string, number> | undefined;
      try {
        const gen = await generateForModel(c.input, model);
        template = gen.template;
        metadata.servedModel = gen.metrics.model;
        const end = Date.now() / 1000;
        metrics = {
          prompt_tokens: gen.metrics.promptTokens,
          completion_tokens: gen.metrics.completionTokens,
          tokens: gen.metrics.promptTokens + gen.metrics.completionTokens,
          start: end - gen.metrics.latencyMs / 1000,
          end,
        };
      } catch (err) {
        metadata.error = String(err);
        console.error(`  ✗ generate [${model} · ${c.id}]: ${String(err)}`);
      }

      if (template) {
        const gate = runGate(template);
        scores.gate_pass_rate = gate.passed / gate.total;
        metadata.gate = gate.checks;

        try {
          const verdict = await judgeRubric(
            c.input,
            template,
            JUDGE_MODEL,
            c.notes,
          );
          for (const key of RUBRIC_KEYS) {
            scores[key] = verdict.dimensions[key].score / 5;
          }
          scores.overall = verdict.overall / 5;
          metadata.judgeSummary = verdict.summary;
          metadata.rationales = Object.fromEntries(
            RUBRIC_KEYS.map((k) => [k, verdict.dimensions[k].rationale]),
          );
        } catch (err) {
          metadata.judgeError = String(err);
          console.error(`  ✗ judge [${model} · ${c.id}]: ${String(err)}`);
        }
      } else {
        // Generation failed: a hard zero so failures pull the model's average
        // down rather than silently dropping out of the aggregate.
        scores.gate_pass_rate = 0;
        scores.overall = 0;
        for (const key of RUBRIC_KEYS) scores[key] = 0;
      }

      // Braintrust rejects an empty (null) output, so use a sentinel on
      // failure and carry the real error in the dedicated `error` field.
      experiment.log({
        input: c.input,
        output: template ?? "GENERATION_FAILED",
        error: metadata.error,
        scores,
        metadata,
        ...(metrics ? { metrics } : {}),
      });
    });

    await experiment.flush();
    const summary = await experiment.summarize();
    console.log(summary);
  }
}

// ---------------------------------------------------------------------------
// Pairwise run (each non-baseline model vs the baseline)
// ---------------------------------------------------------------------------

async function runPairwise(cases: EvalCase[]): Promise<void> {
  const candidates = MODELS.filter((m) => m !== BASELINE);
  if (candidates.length === 0) return;

  console.log(`\n▶ pairwise vs baseline ${BASELINE}…`);

  // Generate the baseline once per case and reuse across candidates.
  const baseline = new Map<string, GeneratedTemplateLite>();
  for (const c of cases) {
    try {
      baseline.set(c.id, (await generateForModel(c.input, BASELINE)).template);
    } catch (err) {
      console.warn(`  baseline failed for ${c.id}: ${String(err)} — skipping`);
    }
  }

  for (const candidate of candidates) {
    const experiment = braintrust.init(`${PROJECT}-pairwise`, {
      experiment: expName(candidate),
      metadata: {
        mode: "model-pairwise",
        candidate,
        baseline: BASELINE,
        judgeModel: JUDGE_MODEL,
        rubricVersion: RUBRIC_VERSION,
        dataset: DATASET,
        cases: cases.length,
      },
    });
    console.log(`  ${candidate} vs ${BASELINE}…`);

    const judgeable = cases.filter((c) => baseline.has(c.id));
    await mapLimit(judgeable, CONCURRENCY, async (c) => {
      const baseTemplate = baseline.get(c.id);
      if (!baseTemplate) return;

      const metadata: Record<string, unknown> = {
        caseId: c.id,
        candidate,
        baseline: BASELINE,
        tags: c.tags,
      };
      let candTemplate: GeneratedTemplateLite | null = null;
      try {
        candTemplate = (await generateForModel(c.input, candidate)).template;
      } catch (err) {
        metadata.error = String(err);
        console.error(`  ✗ generate [${candidate} · ${c.id}]: ${String(err)}`);
        experiment.log({
          input: c.input,
          output: "GENERATION_FAILED",
          error: metadata.error,
          scores: { win_vs_baseline: 0 },
          metadata,
        });
        return;
      }

      try {
        const { winRate, dimWins, verdicts } = await judgePairwiseWinRate(
          c.input,
          candTemplate,
          baseTemplate,
          JUDGE_MODEL,
          c.notes,
        );
        metadata.verdicts = verdicts;
        const scores: Record<string, number> = { win_vs_baseline: winRate };
        for (const [k, v] of Object.entries(dimWins)) scores[`win_${k}`] = v;
        experiment.log({
          input: c.input,
          output: { candidate: candTemplate, baseline: baseTemplate },
          scores,
          metadata,
        });
      } catch (err) {
        metadata.judgeError = String(err);
        console.error(`  ✗ judge [${candidate} · ${c.id}]: ${String(err)}`);
        experiment.log({
          input: c.input,
          output: { candidate: candTemplate, baseline: baseTemplate },
          scores: {},
          metadata,
        });
      }
    });

    await experiment.flush();
    const summary = await experiment.summarize();
    console.log(summary);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  if (!process.env.BRAINTRUST_API_KEY) {
    throw new Error(
      "BRAINTRUST_API_KEY is not set. Create one in Braintrust → Settings → API Keys and export it.",
    );
  }
  if (
    !process.env.BUILDER_OPENROUTER_API_KEY?.trim() &&
    !process.env.EVAL_OPENROUTER_API_KEY?.trim()
  ) {
    throw new Error(
      "No OpenRouter key. Set BUILDER_OPENROUTER_API_KEY (used for generation and, by fallback, judging).",
    );
  }

  const allCases = loadCases(DATASET);
  const cases = LIMIT > 0 ? allCases.slice(0, LIMIT) : allCases;
  console.log(
    `Eval: ${cases.length} cases${LIMIT > 0 ? ` (limited from ${allCases.length})` : ""} × ${MODELS.length} models (${MODELS.join(", ")})\n` +
      `Judge: ${JUDGE_MODEL} · samples: ${SAMPLES} · project: ${PROJECT}` +
      (PAIRWISE ? ` · pairwise vs ${BASELINE}` : ""),
  );
  if (MODELS.includes(JUDGE_MODEL)) {
    console.warn(
      `⚠ Judge model (${JUDGE_MODEL}) is also under test — absolute scores for that model risk self-preference bias. Consider a separate judge.`,
    );
  }

  await runAbsolute(cases);
  if (PAIRWISE) await runPairwise(cases);
  await clearModelOverride();

  console.log(
    "\n✓ Done. Open the experiments in Braintrust to compare models.",
  );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
