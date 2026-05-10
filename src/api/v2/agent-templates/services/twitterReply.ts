/**
 * Twitter Reply Composition Service — composes tweet replies for
 * agent templates built from Twitter @mention requests.
 *
 * Uses Claude Haiku via OpenRouter (same BUILDER_OPENROUTER_API_KEY as templateGen).
 * Composes a tweet reply that:
 *   - Starts with @{handle}
 *   - Contains the template URL
 *   - Does not exceed 270 characters
 *   - Uses a deterministic fallback when LLM fails
 *   - Uses a minimal fallback when agentName is unavailable
 *
 * Fallback hierarchy:
 *   1. LLM-composed reply (truncated to 270 chars if needed, must start with @handle)
 *   2. Deterministic fallback: "@{handle} Meet {agentName} — {firstSentence}. {url}"
 *   3. Minimal fallback: "@{handle} {url}" (when agentName is unavailable)
 *
 * Env vars:
 *   BUILDER_OPENROUTER_API_KEY — required for LLM calls
 *   TWITTER_REPLY_MODEL        — model override (default: anthropic/claude-3-5-haiku-20241022)
 *   TEMPLATE_SITE_URL          — base URL for templates (default: https://convos.org/assistants)
 *
 * Test seam: __resetTwitterReplyForTests(override | null) mirrors the
 * singleton-override pattern used by templateGen, ProvisioningClient, and PostHog.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReplyInput {
  /** Twitter handle of the user who @mentioned the bot (e.g. "@alice"). */
  handle: string;
  /** Name of the generated agent (from templateGen result). */
  agentName: string;
  /** First sentence of the agent's description or prompt. */
  firstSentence: string;
  /** Full URL to the published template. */
  templateUrl: string;
  /** Slug of the published template. */
  slug: string;
}

export interface ReplyResult {
  replyText: string;
}

export type ReplyOverride = (input: ReplyInput) => Promise<ReplyResult>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_REPLY_MODEL = "anthropic/claude-3-5-haiku-20241022";
const DEFAULT_TEMPLATE_SITE_URL = "https://convos.org/assistants";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const REPLY_TIMEOUT_MS = 10_000;
const MAX_REPLY_LENGTH = 270;

// ---------------------------------------------------------------------------
// Lazy env var access — reads at call time, not import time
// ---------------------------------------------------------------------------

function getApiKey(): string | null {
  return process.env.BUILDER_OPENROUTER_API_KEY || null;
}

function getModel(): string {
  return process.env.TWITTER_REPLY_MODEL || DEFAULT_REPLY_MODEL;
}

function getTemplateSiteUrl(): string {
  return process.env.TEMPLATE_SITE_URL || DEFAULT_TEMPLATE_SITE_URL;
}

// ---------------------------------------------------------------------------
// Test seam — singleton override pattern
// ---------------------------------------------------------------------------

let _override: ReplyOverride | null = null;

/**
 * Install a test override for the reply service.
 * Pass `null` to restore normal behaviour.
 */
export function __resetTwitterReplyForTests(
  override: ReplyOverride | null,
): void {
  _override = override;
}

// ---------------------------------------------------------------------------
// Fallback reply generation
// ---------------------------------------------------------------------------

/**
 * Deterministic fallback when LLM fails but agentName is available.
 * Format: "@{handle} Meet {agentName} — {firstSentence}. {url}"
 */
export function buildDeterministicFallback(input: ReplyInput): string {
  const { handle, agentName, firstSentence, slug } = input;
  const url = `${getTemplateSiteUrl()}/${slug}`;

  // Ensure handle starts with @
  const normalizedHandle = handle.startsWith("@") ? handle : `@${handle}`;

  // Truncate firstSentence if needed to fit within 270 chars
  const prefix = `${normalizedHandle} Meet ${agentName} — `;
  const suffix = `. ${url}`;

  const availableForSentence = MAX_REPLY_LENGTH - prefix.length - suffix.length;

  // If the prefix + suffix already exceeds the limit, the URL must remain
  // intact for the reply to be useful, so fall back to the minimal form.
  if (availableForSentence <= 0) {
    return buildMinimalFallback(input);
  }

  let sentence = firstSentence;
  if (sentence.length > availableForSentence) {
    sentence = sentence
      .slice(0, Math.max(0, availableForSentence - 1))
      .trimEnd();
    // Try to cut at last space to avoid cutting a word
    const lastSpace = sentence.lastIndexOf(" ");
    if (lastSpace > 0) {
      sentence = sentence.slice(0, lastSpace);
    }
    sentence += "…";
  }

  return `${prefix}${sentence}${suffix}`;
}

/**
 * Minimal fallback when even agentName is unavailable.
 * Format: "@{handle} {url}"
 */
export function buildMinimalFallback(input: ReplyInput): string {
  const { handle, slug } = input;
  const url = `${getTemplateSiteUrl()}/${slug}`;
  const normalizedHandle = handle.startsWith("@") ? handle : `@${handle}`;
  return `${normalizedHandle} ${url}`;
}

// ---------------------------------------------------------------------------
// Reply prompt
// ---------------------------------------------------------------------------

function buildReplyPrompt(input: ReplyInput): string {
  const { handle, agentName, firstSentence, slug } = input;
  const url = `${getTemplateSiteUrl()}/${slug}`;

  return `You are composing a tweet reply for an AI agent that was just built from a Twitter @mention request.

Requirements:
- Start with the user's handle: ${handle}
- Mention the agent by name: ${agentName}
- Include the template URL: ${url}
- Keep it under 270 characters (well under Twitter's 280 limit)
- Be friendly, enthusiastic, and concise
- Do NOT use hashtags
- Do NOT use emojis (the agent name may contain one)
- The reply should feel natural and conversational

Agent details:
- Name: ${agentName}
- Description: ${firstSentence}
- URL: ${url}

Write ONLY the tweet reply text. No quotes, no explanation, no labels. Just the reply text starting with ${handle}.`;
}

// ---------------------------------------------------------------------------
// Core reply function
// ---------------------------------------------------------------------------

/**
 * Validate and normalize an LLM-composed reply.
 * Returns null if the reply is unusable.
 */
function validateLlmReply(
  rawReply: string,
  handle: string,
  url: string,
): string | null {
  const trimmed = rawReply.trim();
  if (!trimmed) return null;

  const normalizedHandle = handle.startsWith("@") ? handle : `@${handle}`;

  if (!trimmed.startsWith(normalizedHandle)) {
    return null;
  }

  // Reject (rather than truncate) replies that exceed the limit. Truncation
  // can cut the URL mid-string and ship a broken link; the deterministic
  // fallback is short enough to always preserve the URL.
  if (trimmed.length > MAX_REPLY_LENGTH) {
    return null;
  }

  if (!trimmed.includes(url)) {
    return null;
  }

  return trimmed;
}

/**
 * Reply dispatch function — calls the override if installed,
 * otherwise delegates to the real `composeReply`.
 */
export async function composeReply(input: ReplyInput): Promise<ReplyResult> {
  if (_override) {
    return _override(input);
  }
  return _composeReply(input);
}

/**
 * Internal implementation: calls Claude Haiku via OpenRouter for
 * reply composition. Falls back to deterministic template on failure.
 */
async function _composeReply(input: ReplyInput): Promise<ReplyResult> {
  const { handle, agentName, slug } = input;
  const url = `${getTemplateSiteUrl()}/${slug}`;

  // If agentName is unavailable, use minimal fallback immediately (no LLM call)
  if (!agentName || agentName.trim() === "") {
    return { replyText: buildMinimalFallback(input) };
  }

  const apiKey = getApiKey();
  if (!apiKey) {
    console.warn(
      "[twitterReply] BUILDER_OPENROUTER_API_KEY not set, using deterministic fallback",
    );
    return { replyText: buildDeterministicFallback(input) };
  }

  const prompt = buildReplyPrompt(input);
  const model = getModel();

  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, REPLY_TIMEOUT_MS);

  try {
    const res = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.7,
        max_tokens: 100,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(
        `[twitterReply] OpenRouter error ${res.status}: ${body.slice(0, 300)}`,
      );
      return { replyText: buildDeterministicFallback(input) };
    }

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      console.warn("[twitterReply] Empty LLM response, using fallback");
      return { replyText: buildDeterministicFallback(input) };
    }

    const validated = validateLlmReply(content, handle, url);
    if (validated) {
      return { replyText: validated };
    }

    // LLM reply was unusable, fall back to deterministic
    return { replyText: buildDeterministicFallback(input) };
  } catch (err: unknown) {
    const message =
      err instanceof Error
        ? err.message
        : typeof err === "string"
          ? err
          : "unknown error";
    console.error(
      `[twitterReply] Error during reply composition, using fallback: ${message}`,
    );
    return { replyText: buildDeterministicFallback(input) };
  } finally {
    clearTimeout(timeoutId);
  }
}
