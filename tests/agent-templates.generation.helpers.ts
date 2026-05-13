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
  description: "test description",
  prompt: "you are a test",
  category: "Test",
  emoji: "🧪",
  tools: [],
  connections: [],
  ...overrides,
});
