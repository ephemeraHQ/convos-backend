/**
 * Twitter Moderation Service — safety + intent classification for Twitter @mention
 * agent requests.
 *
 * Uses Claude Haiku via OpenRouter (same BUILDER_OPENROUTER_API_KEY as templateGen).
 * Classifies tweet content into three buckets:
 *   - safe_agent_request → { allowed: true }
 *   - unsafe_content      → { allowed: false, reason: "blocked" }
 *   - not_agent_request   → { allowed: false, reason: "not_agent_request" }
 *
 * **Fails open**: on any OpenRouter error (network, non-2xx, parse failure),
 * returns { allowed: true } so that transient infrastructure failures do not
 * block legitimate twitter builds.
 *
 * Env vars:
 *   BUILDER_OPENROUTER_API_KEY — required for LLM calls
 *   TWITTER_MODERATION_MODEL   — model override (default: anthropic/claude-3-5-haiku-20241022)
 *
 * Test seam: __resetTwitterModerationForTests(override | null) mirrors the
 * singleton-override pattern used by templateGen, PlaygroundClient, and PostHog.
 */

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

const DEFAULT_MODERATION_MODEL = "anthropic/claude-3-5-haiku-20241022";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const MODERATION_TIMEOUT_MS = 5_000;

/** The classification labels the LLM is asked to return. */
type _ClassificationLabel =
  | "safe_agent_request"
  | "unsafe_content"
  | "not_agent_request";

// ---------------------------------------------------------------------------
// Lazy env var access — reads at call time, not import time
// ---------------------------------------------------------------------------

function getApiKey(): string | null {
  return process.env.BUILDER_OPENROUTER_API_KEY || null;
}

function getModel(): string {
  return process.env.TWITTER_MODERATION_MODEL || DEFAULT_MODERATION_MODEL;
}

// ---------------------------------------------------------------------------
// Test seam — singleton override pattern
// ---------------------------------------------------------------------------

let _override: ModerationOverride | null = null;

/**
 * Install a test override for the moderation service.
 * Pass `null` to restore normal behaviour.
 */
export function __resetTwitterModerationForTests(
  override: ModerationOverride | null,
): void {
  _override = override;
}

// ---------------------------------------------------------------------------
// Moderation prompt
// ---------------------------------------------------------------------------

function buildModerationPrompt(input: string): string {
  return `You are a content moderation and intent classification system for a Twitter bot that creates AI assistants when users @mention it with requests like "Build me a math tutor bot".

Classify the following tweet text into exactly one of three categories:

- "safe_agent_request": The user is requesting an AI agent/assistant/bot to be built. The content is safe and constitutes a genuine request for an agent. Examples: "Build me a math tutor", "Create a recipe assistant", "Make me a travel planner bot", "I need a bot that helps with coding"

- "unsafe_content": The content contains hate speech, violence, CSAM, harassment, illegal activity, or other harmful material. The request may or may not be for an agent, but the content itself is unsafe. Examples: hate speech, violent threats, sexual content involving minors, instructions for illegal acts

- "not_agent_request": The content is safe but is NOT a request to build an agent/assistant. Examples: "follow me back", "retweet this", "hi", "good morning", "@bot what's up", "lol", generic greetings, requests for the bot to perform actions other than building agents

Respond with ONLY the classification label, nothing else. No quotes, no explanation, no extra text.

Tweet text to classify:
${input}`;
}

// ---------------------------------------------------------------------------
// Core moderation function
// ---------------------------------------------------------------------------

function mapLabelToResult(label: string): ModerationResult {
  const trimmed = label.trim().toLowerCase();

  if (trimmed === "safe_agent_request") {
    return { allowed: true };
  }
  if (trimmed === "unsafe_content") {
    return { allowed: false, reason: "blocked" };
  }
  if (trimmed === "not_agent_request") {
    return { allowed: false, reason: "not_agent_request" };
  }

  // If the label is unexpected, fail open
  console.warn(
    `[twitterModeration] Unexpected classification label: "${label}", failing open`,
  );
  return { allowed: true };
}

/**
 * Moderation dispatch function — calls the override if installed,
 * otherwise delegates to the real `moderateContent`.
 */
export async function moderateContent(
  input: string,
): Promise<ModerationResult> {
  if (_override) {
    return _override(input);
  }
  return _moderateContent(input);
}

/**
 * Internal implementation: calls Claude Haiku via OpenRouter for
 * safety + intent classification. Fails open on any error.
 */
async function _moderateContent(input: string): Promise<ModerationResult> {
  const apiKey = getApiKey();
  if (!apiKey) {
    console.warn(
      "[twitterModeration] BUILDER_OPENROUTER_API_KEY not set, failing open",
    );
    return { allowed: true };
  }

  const prompt = buildModerationPrompt(input);
  const model = getModel();

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, MODERATION_TIMEOUT_MS);

    const res = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.1,
        max_tokens: 20,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(
        `[twitterModeration] OpenRouter error ${res.status}: ${body.slice(0, 300)}`,
      );
      return { allowed: true }; // fail open
    }

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      console.warn("[twitterModeration] Empty LLM response, failing open");
      return { allowed: true };
    }

    return mapLabelToResult(content);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[twitterModeration] Error during moderation, failing open: ${message}`,
    );
    return { allowed: true }; // fail open on network errors, timeouts, etc.
  }
}
