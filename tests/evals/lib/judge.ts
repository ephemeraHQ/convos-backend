/**
 * LLM-as-judge: absolute rubric scoring and pairwise (A/B) comparison.
 *
 * Both modes score against the rubric in rubric.ts (derived from the generator's
 * own playbook). A fixed, strong judge model is used for comparability across
 * the models under test — never let a model judge its own output. Pairwise runs
 * each pair twice with swapped order to cancel position bias.
 */

import { openRouterJSON } from "./llm";
import { RUBRIC, RUBRIC_KEYS } from "./rubric";
import type {
  GeneratedTemplateLite,
  PairwiseChoice,
  PairwiseVerdict,
  RubricVerdict,
} from "./types";

// ---------------------------------------------------------------------------
// Shared judge framing
// ---------------------------------------------------------------------------

const JUDGE_PREAMBLE = `You are a senior reviewer for Convos, a group-chat-first AI platform. You evaluate *generated agent definitions* — system prompts (plus name, emoji, description, category, tools) produced by a generator from a short user idea.

Convos agents live in multi-party group chats. Good agents stay silent by default, speak only when addressed or when their core job fires, keep replies to ~2 sentences (artifacts are the exception), never emit markdown in chat, treat memory as group-level, and have a distinct personality. The generator targets a strict blueprint: BRAIN, SOUL, HEART, THE BRIDGES, THE CONNECTIONS, THE CLOCK, THE ARTIFACTS, THE HOOK, THE SCHEDULE, THE LINE, and a parseable WELCOME MESSAGE.

Two things are added by the system after generation, so do NOT credit or penalize them: a "## Runtime Reminder" brevity block appended to the end of every prompt, and connections (always empty). Judge only the model-authored content above the runtime reminder.

Be a harsh, specific grader. Reward concreteness; penalize generic boilerplate that could describe any agent.`;

function rubricLines(): string {
  return RUBRIC.map(
    (d, i) => `${i + 1}. ${d.key} — ${d.title}: ${d.guidance}`,
  ).join("\n\n");
}

function renderTemplate(t: GeneratedTemplateLite): string {
  return [
    `agentName: ${t.agentName}`,
    `emoji: ${t.emoji}`,
    `description: ${t.description}`,
    `category: ${t.category}`,
    `tools: ${JSON.stringify(t.tools)}`,
    `prompt:\n${t.prompt}`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Absolute scoring
// ---------------------------------------------------------------------------

function absoluteSchema(): Record<string, unknown> {
  const dimProps: Record<string, unknown> = {};
  for (const key of RUBRIC_KEYS) {
    dimProps[key] = {
      type: "object",
      additionalProperties: false,
      required: ["score", "rationale"],
      properties: {
        score: { type: "integer", minimum: 1, maximum: 5 },
        rationale: { type: "string" },
      },
    };
  }
  return {
    type: "object",
    additionalProperties: false,
    required: ["dimensions", "summary"],
    properties: {
      dimensions: {
        type: "object",
        additionalProperties: false,
        required: [...RUBRIC_KEYS],
        properties: dimProps,
      },
      summary: { type: "string" },
    },
  };
}

interface RawAbsolute {
  dimensions: Record<string, { score: number; rationale: string }>;
  summary: string;
}

export async function judgeRubric(
  input: string,
  template: GeneratedTemplateLite,
  judgeModel: string,
  notes?: string,
): Promise<RubricVerdict> {
  const system = `${JUDGE_PREAMBLE}

Score each rubric dimension from 1 (poor) to 5 (excellent), with a one-sentence rationale citing concrete evidence from the prompt. Then give a one-sentence overall summary.

Rubric:
${rubricLines()}`;

  const user = `User idea given to the generator:
"""
${input}
"""
${notes ? `\nWhat a strong output should capture (orientation only, not a reference answer): ${notes}\n` : ""}
Generated agent definition to score:
"""
${renderTemplate(template)}
"""`;

  const raw = (await openRouterJSON({
    model: judgeModel,
    system,
    user,
    schema: absoluteSchema(),
    schemaName: "rubric_scores",
  })) as RawAbsolute;

  const dimensions: RubricVerdict["dimensions"] = {};
  let sum = 0;
  for (const key of RUBRIC_KEYS) {
    const d = raw.dimensions[key];
    dimensions[key] = { score: d.score, rationale: d.rationale };
    sum += d.score;
  }
  return {
    dimensions,
    overall: sum / RUBRIC_KEYS.length,
    summary: raw.summary,
  };
}

// ---------------------------------------------------------------------------
// Pairwise scoring
// ---------------------------------------------------------------------------

function pairwiseSchema(): Record<string, unknown> {
  const dimProps: Record<string, unknown> = {};
  for (const key of RUBRIC_KEYS) {
    dimProps[key] = { type: "string", enum: ["A", "B", "tie"] };
  }
  return {
    type: "object",
    additionalProperties: false,
    required: ["dimensions", "overall", "rationale"],
    properties: {
      dimensions: {
        type: "object",
        additionalProperties: false,
        required: [...RUBRIC_KEYS],
        properties: dimProps,
      },
      overall: { type: "string", enum: ["A", "B", "tie"] },
      rationale: { type: "string" },
    },
  };
}

async function judgePairwiseOnce(
  input: string,
  a: GeneratedTemplateLite,
  b: GeneratedTemplateLite,
  judgeModel: string,
  notes?: string,
): Promise<PairwiseVerdict> {
  const system = `${JUDGE_PREAMBLE}

You are given two generated agent definitions (A and B) for the same user idea. For each rubric dimension, decide which is better ("A", "B", or "tie"), then pick an overall winner. Judge blind: the labels carry no information about which generator produced them.

Rubric:
${rubricLines()}`;

  const user = `User idea given to the generator:
"""
${input}
"""
${notes ? `\nWhat a strong output should capture (orientation only): ${notes}\n` : ""}
Assistant A:
"""
${renderTemplate(a)}
"""

Assistant B:
"""
${renderTemplate(b)}
"""`;

  return (await openRouterJSON({
    model: judgeModel,
    system,
    user,
    schema: pairwiseSchema(),
    schemaName: "pairwise_choice",
  })) as PairwiseVerdict;
}

function overallToCandidateScore(
  overall: PairwiseChoice,
  candidateLabel: "A" | "B",
): number {
  if (overall === "tie") return 0.5;
  return overall === candidateLabel ? 1 : 0;
}

/**
 * Win rate of `candidate` vs `baseline` on one case, in [0,1]. Runs the judge
 * twice with swapped A/B order and averages to cancel position bias. 1 =
 * candidate clearly better, 0.5 = tie / split, 0 = baseline better.
 */
export async function judgePairwiseWinRate(
  input: string,
  candidate: GeneratedTemplateLite,
  baseline: GeneratedTemplateLite,
  judgeModel: string,
  notes?: string,
): Promise<{
  winRate: number;
  dimWins: Record<string, number>;
  verdicts: PairwiseVerdict[];
}> {
  // Order 1: candidate = A. Order 2: candidate = B. allSettled (not all) so a
  // rejection in one ordering can't leave the other as a dangling unhandled
  // rejection; we surface the first failure to the caller's try/catch.
  const settled = await Promise.allSettled([
    judgePairwiseOnce(input, candidate, baseline, judgeModel, notes),
    judgePairwiseOnce(input, baseline, candidate, judgeModel, notes),
  ]);
  const rejected = settled.find((s) => s.status === "rejected");
  if (rejected?.status === "rejected") {
    throw rejected.reason instanceof Error
      ? rejected.reason
      : new Error(String(rejected.reason));
  }
  const [v1, v2] = (settled as PromiseFulfilledResult<PairwiseVerdict>[]).map(
    (s) => s.value,
  );
  const s1 = overallToCandidateScore(v1.overall, "A");
  const s2 = overallToCandidateScore(v2.overall, "B");
  // Same order-bias cancellation per dimension, so the pairwise experiment
  // shows *where* the candidate wins/loses, not just one flat overall.
  const dimWins: Record<string, number> = {};
  for (const key of RUBRIC_KEYS) {
    const d1 = overallToCandidateScore(v1.dimensions[key], "A");
    const d2 = overallToCandidateScore(v2.dimensions[key], "B");
    dimWins[key] = (d1 + d2) / 2;
  }
  return { winRate: (s1 + s2) / 2, dimWins, verdicts: [v1, v2] };
}
