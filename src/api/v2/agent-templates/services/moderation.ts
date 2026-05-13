/**
 * Moderation Service — universal content safety check for agent-template
 * generation requests.
 *
 * Uses Claude Haiku via OpenRouter (same BUILDER_OPENROUTER_API_KEY as templateGen).
 * Classifies arbitrary input text into safe vs unsafe content.
 *
 * **Fails open**: on any OpenRouter error (network, non-2xx, parse failure),
 * returns { allowed: true } so transient infrastructure failures do not
 * block legitimate submissions.
 *
 * Env vars:
 *   BUILDER_OPENROUTER_API_KEY — required for LLM calls (unset → fails open)
 *   CONTENT_MODERATION_MODEL   — model override (default: anthropic/claude-3-5-haiku-20241022)
 *
 * Test seam: __resetModerationForTests(override | null) mirrors the
 * singleton-override pattern used by templateGen and PostHog.
 *
 * Exports:
 *   - checkContent(text) — universal content safety. Source-agnostic.
 *     Runs on every submission per the agent-templates refactor plan.
 *
 * (PR #201 will add checkTwitterIntent to this file for twitter-only
 * intent classification.)
 */

import { BUILDER_OPENROUTER_API_KEY, CONTENT_MODERATION_MODEL } from "@/config";
import logger from "@/utils/logger";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ModerationResult {
  allowed: boolean;
  reason?: string;
}

export type ModerationOverride = (input: string) => Promise<ModerationResult>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const MODERATION_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------------------
// Config-backed accessors (with test-only override seams)
// ---------------------------------------------------------------------------

let _apiKeyOverride: string | null | undefined = undefined;
let _contentModelOverride: string | null = null;

function getApiKey(): string | null {
  // `undefined` ⇒ fall through to config; `null` ⇒ explicitly "no key set"
  // (tests use this to exercise the fail-open / skip-fetch path).
  if (_apiKeyOverride !== undefined) return _apiKeyOverride;
  return BUILDER_OPENROUTER_API_KEY || null;
}

function getContentModel(): string {
  return _contentModelOverride ?? CONTENT_MODERATION_MODEL;
}

/** Override `BUILDER_OPENROUTER_API_KEY` for tests.
 *  - Pass a string to override.
 *  - Pass `null` to simulate "no API key set" (forces fail-open path).
 *  - Pass `undefined` to clear the override and fall back to config. */
export function __setBuilderApiKeyOverrideForTests(
  key: string | null | undefined,
): void {
  _apiKeyOverride = key;
}

/** Override `CONTENT_MODERATION_MODEL` for tests. Pass `null` to clear. */
export function __setContentModelOverrideForTests(model: string | null): void {
  _contentModelOverride = model;
}

// ---------------------------------------------------------------------------
// Test seam — singleton override pattern
// ---------------------------------------------------------------------------

let _contentOverride: ModerationOverride | null = null;

/**
 * Install a test override for `checkContent`.
 * Pass `null` to restore normal behaviour.
 */
export function __resetModerationForTests(
  override: ModerationOverride | null,
): void {
  _contentOverride = override;
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

function buildContentPrompt(input: string): string {
  return `You are a content safety classifier for an AI assistant template generation service.

Classify the following input text into exactly one of two categories:

- "safe": The content is safe to process. It may be a request for any kind of assistant or contain ordinary product descriptions, code, documents, or other benign material.

- "unsafe": The content contains hate speech, threats of violence, CSAM, harassment, instructions for illegal activity, or other harmful material that should not be processed.

Be conservative — only classify as "unsafe" when content is clearly harmful. Ordinary, benign, or borderline-edgy content should be "safe".

Respond with ONLY the classification label, nothing else. No quotes, no explanation, no extra text.

Input text to classify:
${input}`;
}

// ---------------------------------------------------------------------------
// Result mapping
// ---------------------------------------------------------------------------

function mapContentLabel(label: string): ModerationResult {
  const trimmed = label.trim().toLowerCase();

  if (trimmed === "safe") {
    return { allowed: true };
  }
  if (trimmed === "unsafe") {
    return { allowed: false, reason: "blocked" };
  }

  // Unexpected label — fail open
  logger.warn(
    { label },
    "[moderation:content] Unexpected classification label, failing open",
  );
  return { allowed: true };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Universal content safety check. Runs on every generation submission.
 * Fails open on infrastructure errors.
 */
export async function checkContent(input: string): Promise<ModerationResult> {
  if (_contentOverride) {
    return _contentOverride(input);
  }
  return _checkContent(input);
}

// ---------------------------------------------------------------------------
// Internal implementation
// ---------------------------------------------------------------------------

async function _checkContent(input: string): Promise<ModerationResult> {
  return _classify({
    input,
    promptBuilder: buildContentPrompt,
    labelMapper: mapContentLabel,
    model: getContentModel(),
    logTag: "[moderation:content]",
  });
}

interface ClassifyOptions {
  input: string;
  promptBuilder: (input: string) => string;
  labelMapper: (label: string) => ModerationResult;
  model: string;
  logTag: string;
}

async function _classify(opts: ClassifyOptions): Promise<ModerationResult> {
  const apiKey = getApiKey();
  if (!apiKey) {
    logger.warn(
      `${opts.logTag} BUILDER_OPENROUTER_API_KEY not set, failing open`,
    );
    return { allowed: true };
  }

  const prompt = opts.promptBuilder(opts.input);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, MODERATION_TIMEOUT_MS);

  try {
    const res = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: opts.model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.1,
        max_tokens: 20,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logger.error(
        { status: res.status, body: body.slice(0, 300) },
        `${opts.logTag} OpenRouter error`,
      );
      return { allowed: true };
    }

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      logger.warn(`${opts.logTag} Empty LLM response, failing open`);
      return { allowed: true };
    }

    return opts.labelMapper(content);
  } catch (err: unknown) {
    logger.error(
      { err },
      `${opts.logTag} Error during moderation, failing open`,
    );
    return { allowed: true };
  } finally {
    clearTimeout(timeoutId);
  }
}

// ---------------------------------------------------------------------------
// Internal — exported for PR #201 to extend with checkTwitterIntent.
// PR #200 only ships checkContent.
// ---------------------------------------------------------------------------

export const __internal = {
  classify: _classify,
};
