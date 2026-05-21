/**
 * Generator-prompt regression eval: A/B two versions of
 * data/template-generator-prompt.txt (base branch vs PR), holding the model
 * fixed. For each dataset case it generates with both prompts and asks the judge
 * which output is better (pairwise, order-swapped to cancel position bias). The
 * candidate is the PR (head) prompt; the baseline is the base prompt — so
 * win_vs_baseline > 0.5 means the PR prompt improved generations.
 *
 * Logs one Braintrust experiment and writes a markdown summary to stdout and to
 * $GITHUB_STEP_SUMMARY (so it renders on the Actions run). Informational by
 * default; pass --fail-under <x> to fail the job when the mean win rate drops
 * below x (a regression gate).
 *
 * Usage (see .github/workflows/eval-prompt.yml):
 *   bun run tests/evals/compare-prompts.ts \
 *     --base /tmp/base-prompt.txt \
 *     --head data/template-generator-prompt.txt \
 *     --model anthropic/claude-opus-4.7
 */

import { appendFileSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import * as braintrust from "braintrust";
import { loadCases } from "./lib/dataset";
import { clearModelOverride, generateForModel } from "./lib/generate";
import { judgePairwiseWinRate } from "./lib/judge";
import { RUBRIC_KEYS, RUBRIC_VERSION } from "./lib/rubric";
import type { GeneratedTemplateLite } from "./lib/types";

const { values } = parseArgs({
  options: {
    base: { type: "string" },
    head: { type: "string" },
    model: { type: "string" },
    judge: { type: "string" },
    dataset: { type: "string" },
    limit: { type: "string" },
    project: { type: "string" },
    concurrency: { type: "string" },
    label: { type: "string" },
    "fail-under": { type: "string" },
  },
});

const BASE = values.base ?? process.env.EVAL_BASE_PROMPT;
const HEAD =
  values.head ??
  process.env.EVAL_HEAD_PROMPT ??
  "data/template-generator-prompt.txt";
const MODEL =
  values.model ?? process.env.EVAL_MODEL ?? "anthropic/claude-opus-4.7";
const JUDGE_MODEL =
  values.judge ?? process.env.EVAL_JUDGE_MODEL ?? "openai/gpt-5.5";
const DATASET =
  values.dataset ??
  process.env.EVAL_DATASET ??
  "tests/evals/datasets/core.jsonl";
const LIMIT = Number(values.limit ?? process.env.EVAL_LIMIT ?? "0");
const PROJECT =
  values.project ?? process.env.EVAL_PROJECT ?? "convos-prompt-regression";
const CONCURRENCY = Number(
  values.concurrency ?? process.env.EVAL_CONCURRENCY ?? "4",
);
const LABEL =
  values.label ?? process.env.EVAL_LABEL ?? new Date().toISOString();
const FAIL_UNDER = Number(
  values["fail-under"] ?? process.env.EVAL_FAIL_UNDER ?? "0",
);

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () =>
      (async () => {
        while (cursor < items.length) {
          const i = cursor++;
          results[i] = await fn(items[i]);
        }
      })(),
    ),
  );
  return results;
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
}

function verdictLabel(winRate: number): string {
  if (winRate > 0.55) return "✅ PR prompt better";
  if (winRate < 0.45) return "🔴 regression (base better)";
  return "➖ neutral / too close to call";
}

function emitSummary(md: string): void {
  console.log(md);
  const f = process.env.GITHUB_STEP_SUMMARY;
  if (f) {
    try {
      appendFileSync(f, md + "\n");
    } catch {
      /* not fatal */
    }
  }
}

async function main(): Promise<void> {
  if (!process.env.BRAINTRUST_API_KEY) {
    throw new Error("BRAINTRUST_API_KEY is not set.");
  }
  if (
    !process.env.BUILDER_OPENROUTER_API_KEY?.trim() &&
    !process.env.EVAL_OPENROUTER_API_KEY?.trim()
  ) {
    throw new Error(
      "No OpenRouter key (BUILDER_OPENROUTER_API_KEY or EVAL_OPENROUTER_API_KEY).",
    );
  }
  if (!BASE) {
    throw new Error(
      "--base <file> is required (the base-branch prompt to compare against).",
    );
  }

  const basePrompt = readFileSync(BASE, "utf8").trim();
  const headPrompt = readFileSync(HEAD, "utf8").trim();
  if (basePrompt === headPrompt) {
    emitSummary(
      `## Generator prompt eval\n\nBase and head prompts are identical — nothing to compare.`,
    );
    return;
  }

  const all = loadCases(DATASET);
  const cases = LIMIT > 0 ? all.slice(0, LIMIT) : all;
  console.log(
    `Prompt A/B: head(${HEAD}) vs base(${BASE}) · model ${MODEL} · judge ${JUDGE_MODEL} · ${cases.length} cases`,
  );

  const experiment = braintrust.init(PROJECT, {
    experiment: LABEL,
    metadata: {
      mode: "prompt-regression",
      model: MODEL,
      judgeModel: JUDGE_MODEL,
      rubricVersion: RUBRIC_VERSION,
      dataset: DATASET,
      cases: cases.length,
      basePrompt: BASE,
      headPrompt: HEAD,
    },
  });

  const winRates: number[] = [];
  const dimRates: Record<string, number[]> = Object.fromEntries(
    RUBRIC_KEYS.map((k) => [k, [] as number[]]),
  );
  const losers: string[] = [];

  await mapLimit(cases, CONCURRENCY, async (c) => {
    const metadata: Record<string, unknown> = {
      caseId: c.id,
      tags: c.tags,
      model: MODEL,
    };
    let head: GeneratedTemplateLite | null = null;
    let base: GeneratedTemplateLite | null = null;
    try {
      // Both calls serialize through the generation chain internally.
      head = (await generateForModel(c.input, MODEL, headPrompt)).template;
      base = (await generateForModel(c.input, MODEL, basePrompt)).template;
    } catch (err) {
      metadata.error = String(err);
      console.error(`  ✗ generate [${c.id}]: ${String(err)}`);
    }

    if (!head || !base) {
      // If the PR prompt is the one that failed, that's a hard regression (0).
      const win = !head && base ? 0 : 0.5;
      winRates.push(win);
      experiment.log({
        input: c.input,
        output: "GENERATION_FAILED",
        error: metadata.error,
        scores: { win_vs_baseline: win },
        metadata,
      });
      return;
    }

    try {
      const { winRate, dimWins, verdicts } = await judgePairwiseWinRate(
        c.input,
        head,
        base,
        JUDGE_MODEL,
        c.notes,
      );
      metadata.verdicts = verdicts;
      winRates.push(winRate);
      if (winRate < 0.5) losers.push(c.id);
      const scores: Record<string, number> = { win_vs_baseline: winRate };
      for (const [k, v] of Object.entries(dimWins)) {
        scores[`win_${k}`] = v;
        dimRates[k].push(v);
      }
      experiment.log({
        input: c.input,
        output: { head, base },
        scores,
        metadata,
      });
    } catch (err) {
      metadata.judgeError = String(err);
      console.error(`  ✗ judge [${c.id}]: ${String(err)}`);
      experiment.log({
        input: c.input,
        output: { head, base },
        scores: {},
        metadata,
      });
    }
  });

  await experiment.flush();
  const summary = await experiment.summarize();
  const url = (summary as { experimentUrl?: string }).experimentUrl;

  const overall = mean(winRates);
  const dimLines = RUBRIC_KEYS.map(
    (k) => `| ${k} | ${mean(dimRates[k]).toFixed(2)} |`,
  ).join("\n");
  await clearModelOverride();

  emitSummary(
    `## Generator prompt eval — PR vs base\n\n` +
      `Model \`${MODEL}\` · judge \`${JUDGE_MODEL}\` · ${cases.length} cases (\`${DATASET}\`)\n\n` +
      `**PR prompt win rate vs base: ${overall.toFixed(2)}** — ${verdictLabel(overall)}\n\n` +
      `| dimension | PR win rate |\n| --- | --- |\n${dimLines}\n\n` +
      (losers.length
        ? `Cases where the PR prompt lost: ${losers.join(", ")}\n\n`
        : `No cases where the PR prompt lost.\n\n`) +
      (url ? `[Full results in Braintrust →](${url})\n` : ""),
  );

  if (FAIL_UNDER > 0 && overall < FAIL_UNDER) {
    console.error(
      `Win rate ${overall.toFixed(2)} < --fail-under ${FAIL_UNDER} → failing.`,
    );
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
