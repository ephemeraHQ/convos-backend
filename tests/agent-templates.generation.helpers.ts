import type { DistillResult } from "@/api/v2/agent-templates/services/distill";
import type { GeneratedTemplate } from "@/api/v2/agent-templates/services/templateGen";

/**
 * Build a `GeneratedTemplate` fixture for tests of the async generation
 * pipeline. Returns a complete, validation-passing template by default;
 * any field can be overridden via the `overrides` argument.
 *
 * Six PR #204/#205 test files were each declaring their own near-identical
 * `fakeTemplate` constant — only `agentName` (and occasionally
 * `description` / `emoji`) varied per file. Use this helper instead so the
 * default shape lives in one place and tests only spell out what's
 * meaningfully different from the default.
 *
 * Example:
 *   const fakeTemplate = makeFakeTemplate({ agentName: "Tweet Replier" });
 */
export const makeFakeTemplate = (
  overrides: Partial<GeneratedTemplate> = {},
): GeneratedTemplate => ({
  agentName: "Test Agent",
  jobTitle: "Test Role",
  description: "test description",
  prompt: "you are a test",
  category: "Test",
  emoji: "🧪",
  tools: [],
  connections: [],
  ...overrides,
});

/**
 * Build a `DistillResult` fixture for tests that exercise the real executor.
 * Install it via `__resetDistillForTests(() => Promise.resolve(makeFakeDistill()))`
 * so the distill stage is deterministic and never fires a real OpenRouter call.
 */
export const makeFakeDistill = (
  overrides: Partial<DistillResult> = {},
): DistillResult => ({
  agentName: "Distilled Agent",
  emoji: "✨",
  description: "a distilled description",
  progressPhrases: [
    "Writing how it thinks",
    "Shaping its voice",
    "Teaching it group manners",
    "Wiring its tools",
    "Setting its check-ins",
    "Drafting its hello",
  ],
  ...overrides,
});
