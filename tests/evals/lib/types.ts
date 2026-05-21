/**
 * Shared types for the agent-prompt eval harness.
 *
 * The harness drives the *real* template generation path (templateGen.ts) across
 * a set of models, then scores each output with an LLM-as-judge against a rubric
 * derived from data/template-generator-prompt.txt (the same spec the generator
 * targets). Results are logged to Braintrust as experiments. See
 * tests/evals/README.md.
 */

/** One eval input. Plain-text ideas only — they hit the main generation LLM
 *  path. URL / PDF / passthrough cases are verbatim wraps, not model-dependent,
 *  so they're out of scope for a model-quality comparison. */
export interface EvalCase {
  id: string;
  /** The idea fed to the generator, as a user would type it in the composer. */
  input: string;
  /** What a strong output should capture. Given to the judge as orienting
   *  context, NOT as a strict reference answer. */
  notes?: string;
  /** Tags for slicing the report (e.g. "short-idea", "sensitive", "work"). */
  tags?: string[];
}

/** The model-authored fields of a generated template. `connections` is always
 *  server-injected as [], so it's excluded. */
export interface GeneratedTemplateLite {
  agentName: string;
  description: string;
  prompt: string;
  category: string;
  emoji: string;
  tools: string[];
}

export interface GenMetrics {
  model: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
}

/** Cheap deterministic checks — model-agnostic, run before the judge so obvious
 *  structural failures are caught for free and the judge focuses on quality. */
export interface GateResult {
  checks: Record<string, boolean>;
  passed: number;
  total: number;
}

export interface DimensionScore {
  score: number;
  rationale: string;
}

/** Absolute (single-output) rubric verdict. `overall` is the mean of the
 *  dimension scores, computed in TS — not asked of the judge — so it stays
 *  comparable across runs. */
export interface RubricVerdict {
  dimensions: Record<string, DimensionScore>;
  overall: number;
  summary: string;
}

export type PairwiseChoice = "A" | "B" | "tie";

export interface PairwiseVerdict {
  dimensions: Record<string, PairwiseChoice>;
  overall: PairwiseChoice;
  rationale: string;
}
