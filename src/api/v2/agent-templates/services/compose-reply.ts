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
 *   1. LLM-composed reply (must start with @handle, contain url, ≤ 270 chars)
 *   2. Deterministic: "@{handle} Meet {agentName} — {firstSentence}. {url}"
 *   3. Minimal: "@{handle} {url}" (when agentName is unavailable)
 *
 * Env vars:
 *   BUILDER_OPENROUTER_API_KEY — required for LLM calls
 *   TWITTER_REPLY_MODEL        — model override (default: anthropic/claude-3-5-haiku-20241022)
 *   BUILDER_SITE_URL           — base URL for builder (default: https://convos.org/assistants)
 *
 * Test seam: __resetComposeReplyForTests(override | null).
 */

import { BUILDER_OPENROUTER_API_KEY, TWITTER_REPLY_MODEL } from "@/config";
import logger from "@/utils/logger";
import { templateUrlFromHashedSlug } from "../lib/template-url";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReplyInput {
  /** Twitter handle of the user who @mentioned the bot (e.g. "@alice"). */
  handle: string;
  /** Name of the generated agent. */
  agentName: string;
  /** First sentence of the agent's description or prompt. */
  firstSentence: string;
  /** **Canonical (hashed) public slug** — e.g. `"brewski.x4f9k"`, the value
   *  produced by `buildSlug(baseSlug, templateId)`. Callers must NOT pass the
   *  base slug stored on `AgentTemplate.slug` directly: the public URL
   *  resolver (resolve-id-or-hashed-slug.ts) requires the `<base>.<hash>`
   *  form, so passing the base alone would render a reply URL that 404s. */
  slug: string;
}

export interface ReplyResult {
  replyText: string;
}

export type ReplyOverride = (input: ReplyInput) => Promise<ReplyResult>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const REPLY_TIMEOUT_MS = 10_000;
const MAX_REPLY_LENGTH = 270;

function getApiKey(): string | null {
  return BUILDER_OPENROUTER_API_KEY || null;
}

function getModel(): string {
  return TWITTER_REPLY_MODEL;
}

function templateUrlFor(slug: string): string {
  return templateUrlFromHashedSlug(slug);
}

function normalizeHandle(handle: string): string {
  return handle.startsWith("@") ? handle : `@${handle}`;
}

// ---------------------------------------------------------------------------
// Test seam
// ---------------------------------------------------------------------------

let _override: ReplyOverride | null = null;

export function __resetComposeReplyForTests(
  override: ReplyOverride | null,
): void {
  _override = override;
}

// ---------------------------------------------------------------------------
// Fallback reply generation
// ---------------------------------------------------------------------------

/** Deterministic fallback: "@{handle} Meet {agentName} — {firstSentence}. {url}" */
export function buildDeterministicFallback(input: ReplyInput): string {
  const { handle, agentName, firstSentence, slug } = input;
  const url = templateUrlFor(slug);
  const normalizedHandle = normalizeHandle(handle);

  const prefix = `${normalizedHandle} Meet ${agentName} — `;
  const suffix = `. ${url}`;
  const availableForSentence = MAX_REPLY_LENGTH - prefix.length - suffix.length;

  if (availableForSentence <= 0) {
    return buildMinimalFallback(input);
  }

  let sentence = firstSentence;
  if (sentence.length > availableForSentence) {
    sentence = sentence
      .slice(0, Math.max(0, availableForSentence - 1))
      .trimEnd();
    const lastSpace = sentence.lastIndexOf(" ");
    if (lastSpace > 0) sentence = sentence.slice(0, lastSpace);
    sentence += "…";
  }

  return `${prefix}${sentence}${suffix}`;
}

/** Minimal fallback when even agentName is unavailable. */
export function buildMinimalFallback(input: ReplyInput): string {
  return `${normalizeHandle(input.handle)} ${templateUrlFor(input.slug)}`;
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

function buildReplyPrompt(input: ReplyInput): string {
  const { handle, agentName, firstSentence, slug } = input;
  const url = templateUrlFor(slug);
  // Normalize once so the LLM is instructed to produce the same form that
  // validateLlmReply() checks for. Otherwise a caller passing "alice" (no @)
  // gets a prompt that says "start with: alice", LLM does exactly that,
  // and validation rejects because it expects "@alice" — pushing every
  // un-prefixed handle through the deterministic fallback unnecessarily.
  const normalizedHandle = normalizeHandle(handle);

  return `You are composing a tweet reply for an AI agent that was just built from a Twitter @mention request.

Requirements:
- Start with the user's handle: ${normalizedHandle}
- Mention the agent by name: ${agentName}
- Include the template URL: ${url}
- Keep it under ${MAX_REPLY_LENGTH} characters (well under Twitter's 280 limit)
- Be friendly, enthusiastic, and concise
- Do NOT use hashtags
- Do NOT use emojis (the agent name may contain one)
- The reply should feel natural and conversational

Agent details:
- Name: ${agentName}
- Description: ${firstSentence}
- URL: ${url}

Write ONLY the tweet reply text. No quotes, no explanation, no labels. Just the reply text starting with ${normalizedHandle}.`;
}

// ---------------------------------------------------------------------------
// LLM reply validation
// ---------------------------------------------------------------------------

function validateLlmReply(
  rawReply: string,
  handle: string,
  url: string,
): string | null {
  const trimmed = rawReply.trim();
  if (!trimmed) return null;
  const normalizedHandle = normalizeHandle(handle);
  if (!trimmed.startsWith(normalizedHandle)) return null;
  if (trimmed.length > MAX_REPLY_LENGTH) return null;
  if (!trimmed.includes(url)) return null;
  return trimmed;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function composeReply(input: ReplyInput): Promise<ReplyResult> {
  if (_override) return _override(input);
  return _composeReply(input);
}

async function _composeReply(input: ReplyInput): Promise<ReplyResult> {
  const { handle, agentName, slug } = input;
  const url = templateUrlFor(slug);

  if (!agentName || agentName.trim() === "") {
    return { replyText: buildMinimalFallback(input) };
  }

  const apiKey = getApiKey();
  if (!apiKey) {
    logger.warn(
      "[compose-reply] BUILDER_OPENROUTER_API_KEY not set, using deterministic fallback",
    );
    return { replyText: buildDeterministicFallback(input) };
  }

  const prompt = buildReplyPrompt(input);
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
        model: getModel(),
        messages: [{ role: "user", content: prompt }],
        temperature: 0.7,
        max_tokens: 100,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logger.error(
        { status: res.status, body: body.slice(0, 300) },
        "[compose-reply] OpenRouter error",
      );
      return { replyText: buildDeterministicFallback(input) };
    }

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      logger.warn("[compose-reply] Empty LLM response, using fallback");
      return { replyText: buildDeterministicFallback(input) };
    }

    const validated = validateLlmReply(content, handle, url);
    if (validated) return { replyText: validated };

    return { replyText: buildDeterministicFallback(input) };
  } catch (err: unknown) {
    logger.error(
      { err },
      "[compose-reply] Error during reply composition, using fallback",
    );
    return { replyText: buildDeterministicFallback(input) };
  } finally {
    clearTimeout(timeoutId);
  }
}
