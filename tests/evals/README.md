# Agent-prompt eval harness

Gauges the quality of **generated agent prompts**. It drives the _real_
generation pipeline (`src/api/v2/agent-templates/services/templateGen.ts`) so it
measures what production ships — the playbook system prompt, the strict
json_schema, the appended brevity rail, soft defaults, and the empty-prompt
rejection — then scores each output with an LLM-as-judge against a rubric derived
from `data/template-generator-prompt.txt`. Results are logged to **Braintrust**
for side-by-side experiment comparison.

Two modes:

- **Model bake-off** (`run.ts`) — same prompt, different generation models. "Is
  gemini-flash good enough to replace opus for generation?"
- **Prompt regression** (`compare-prompts.ts`) — same model, base-branch prompt
  vs PR prompt. Runs automatically in CI when `data/template-generator-prompt.txt`
  changes. "Did my prompt edit make generations better or worse?"

## What it measures

1. **Deterministic gate** (`lib/checks.ts`) — free, model-agnostic structural
   checks: tools ⊆ allowed set, category in taxonomy, non-generic name,
   `Character:` line, parseable `WELCOME MESSAGE`, sane authored word count.
2. **LLM-as-judge rubric** (`lib/rubric.ts`, `lib/judge.ts`) — six dimensions
   scored 1–5 by a fixed strong judge model, normalized to [0,1]:
   `blueprint_completeness`, `group_chat_fit`, `faithfulness`, `specificity`,
   `constraint_compliance`, `persona_quality`. `overall` is their mean.
3. **Pairwise** — A vs B, judged per dimension with order swapped to cancel
   position bias. Logged as `win_vs_baseline` and `win_<dimension>` ∈ [0,1],
   always from the **candidate's** perspective (1 = candidate better, 0.5 = tie,
   0 = baseline better).

## Setup

1. Braintrust account → **Settings → API Keys** → create a key.
2. Export keys (the runners read them from the environment; `pnpm tsx` does
   not auto-load `.env`, so either `export` them in your shell or use a tool
   like `direnv`):
   ```bash
   export BRAINTRUST_API_KEY=...            # required
   export EVAL_OPENROUTER_API_KEY=...       # powers generation AND the judge
   # export BUILDER_OPENROUTER_API_KEY=...  # also works; set both only to bill
   #                                        # the judge on a separate key
   ```
   At least one OpenRouter key is required. The judge prefers
   `EVAL_OPENROUTER_API_KEY`; generation prefers `BUILDER_OPENROUTER_API_KEY` and
   falls back to `EVAL_OPENROUTER_API_KEY` when it's unset. You do **not** need
   Braintrust's global CLI (`braintrust.dev/cli/setup.sh`); we run the SDK
   directly via `pnpm tsx`.

## Quickstart (start with a smoke run)

A full run is slow and costs real tokens (see below), so try a tiny one first:

```bash
# ~1-2 min: one fast model, 2-case smoke dataset, no pairwise
pnpm eval:models --models google/gemini-3.5-flash \
  --dataset tests/evals/datasets/smoke.jsonl

# or cap any dataset to N cases:
pnpm eval:models --limit 2
```

Then open the printed Braintrust experiment URL.

**Runtime/cost expectations:** opus generation is ~50s per case. A default run
(12 cases × 2 models, absolute only ≈ 24 generations + judge calls, serialized)
takes roughly 10–20 min; adding `--pairwise` roughly doubles it. Use `--limit`,
the smoke dataset, or a single fast model to iterate cheaply; reserve the full
run for a real decision.

## Mode A — model bake-off

```bash
pnpm eval:models                         # opus-4.7 vs gemini-3.5-flash
pnpm eval:models \
  --models anthropic/claude-opus-4.7,google/gemini-3.5-flash \
  --judge openai/gpt-5.5 \
  --dataset tests/evals/datasets/core.jsonl \
  --samples 1 --pairwise
```

Flags (each also reads an env var; flags win): `--models` (`EVAL_MODELS`),
`--judge` (`EVAL_JUDGE_MODEL`), `--dataset` (`EVAL_DATASET`), `--samples`
(`EVAL_SAMPLES`), `--baseline` (`EVAL_BASELINE_MODEL`), `--limit` (`EVAL_LIMIT`),
`--project` (`EVAL_PROJECT`), `--concurrency` (`EVAL_CONCURRENCY`), `--pairwise`
(opt-in head-to-head; off unless passed).

Use a **concrete** OpenRouter model id (not a `@preset/...` alias) so the model
under test is unambiguous. Logs to project `convos-agent-prompts` (absolute) and
`convos-agent-prompts-pairwise`.

## Mode B — prompt regression (base vs PR)

Compares two versions of `data/template-generator-prompt.txt` with the model held
fixed. Run it locally — with no `--base`, it compares your working tree against
the default branch (`origin/otr-dev`):

```bash
git fetch origin                     # make sure origin/otr-dev is current
pnpm eval:prompt                                              # core dataset
pnpm eval:prompt --dataset tests/evals/datasets/smoke.jsonl --limit 2  # quick
```

Or compare two explicit prompt files (this is how CI runs it, passing the base
commit's version):

```bash
pnpm eval:prompt \
  --base /path/to/old-prompt.txt \
  --head data/template-generator-prompt.txt \
  --model anthropic/claude-opus-4.7
```

`--base-ref` (default `origin/otr-dev`) is the git ref the base is extracted from
when `--base` is omitted. `--fail-under 0.45` makes it exit non-zero when the
mean win rate drops below the threshold (a regression gate). It prints a markdown
summary and writes it to `$GITHUB_STEP_SUMMARY`.

**In CI:** `.github/workflows/eval-prompt.yml` triggers on PRs that touch
`data/template-generator-prompt.txt`, extracts the base-branch version of the
prompt (`git show <base-sha>:…`), runs the comparison, and renders the win-rate
summary on the Actions run page. Requires repo secrets `BRAINTRUST_API_KEY` and
`EVAL_OPENROUTER_API_KEY`; it's informational by default (uncomment `--fail-under`
in the workflow to gate merges).

## How to read the scorecard

- **Absolute experiment** is the primary signal: per-dimension means (0–1) +
  `gate_pass_rate`, plus tokens/duration per row in the metrics columns. This is
  where the model-vs-model or prompt quality gap lives, with nuance.
- **Pairwise experiment** is a coarse holistic tiebreaker: `win_vs_baseline` and
  `win_<dimension>` from the candidate's POV. A flat 0 means the candidate lost
  every case — check the absolute dimensions to see _where_.
- **Cost may read blank** in Braintrust: it auto-prices only models it
  recognizes, and we pass OpenRouter-style ids. Tokens + duration always
  populate; per-call USD is tracked product-side in PostHog.
- **Drill into a row** for the judge's per-dimension rationale (in metadata).

## Design notes & caveats

- **Why the SDK, not `braintrust eval`:** the CLI bundles with esbuild, which
  won't resolve this repo's `@/` path aliases inside `templateGen.ts`'s import
  graph. `tsx` resolves them via `tsconfig.json` at runtime, so the runners
  use `braintrust.init()`/`.log()` directly under `pnpm tsx`.
- **Override seams:** generation reads process-global overrides for the model
  (`__setBuilderModelOverrideForTests`), API key, and system prompt
  (`__setSystemPromptOverrideForTests`). `lib/generate.ts` serializes every
  generation through a promise chain so concurrent cases can't clobber them;
  judging still parallelizes.
- **No product-analytics pollution:** `POSTHOG_PROJECT_TOKEN` is left unset, so
  eval generations fall back to a plain OpenAI client (no `$ai_generation`
  events). Judge calls bypass the product client entirely.
- **Variance:** generation runs at `temperature: 0.7`. For stable comparisons,
  raise `--samples` (model bake-off) and read the aggregate.
- **Self-judging:** don't use a judge model that's also under test — `run.ts`
  warns when you do. Pairwise blinds A/B labels but a model can still favor its
  own style.
- **Scope:** plain-text ideas only (the main LLM path). URL / PDF / GitHub
  passthrough cases are verbatim wraps, not model-dependent.

## Datasets

`datasets/core.jsonl` (12 cases) and `datasets/smoke.jsonl` (2 cases) — one JSON
object per line: `{ id, input, notes?, tags? }`. `notes` orients the judge (not a
reference answer). To grow a realistic set, mine real inputs from the
`AgentTemplateGeneration` table and anonymize them.

## Offline tests

The harness's own gate logic is unit-tested with no network:

```bash
pnpm test tests/evals/checks.test.ts
```
