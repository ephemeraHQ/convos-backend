/**
 * Content-safety service for the agent-template generation pipeline — both the
 * input safety gate (moderation) and the output PII scrub (redaction). Same
 * fast model via OpenRouter (Gemini Flash-Lite), same BUILDER_OPENROUTER_API_KEY.
 *
 * Two stages, opposite failure postures by design:
 *
 *   - **Moderation** (`checkContent` / `checkTwitterIntent`) runs at request
 *     time over the user's INPUT and **fails open**: a transient infra blip
 *     shouldn't block a legitimate submission.
 *   - **Redaction** (`redactTemplatePii`) runs at persist time over the
 *     GENERATED template (agentName/description/prompt) and **fails closed**:
 *     a shared/persisted artifact must never carry un-scanned PII, so any error
 *     fails the generation. Detection-only — the model returns exact spans and
 *     we strip them deterministically in code (never a model rewrite).
 *
 * Env vars:
 *   BUILDER_OPENROUTER_API_KEY — required for LLM calls (moderation fails open if unset; redaction fails closed)
 *   CONTENT_MODERATION_MODEL   — moderation model (default: google/gemini-3.1-flash-lite)
 *   PII_REDACTION_MODEL        — redaction model (default: google/gemini-3.1-flash-lite)
 *
 * Test seams (singleton-override pattern):
 *   __resetModerationForTests / __resetTwitterIntentForTests / __resetPiiRedactionForTests
 *   __setBuilderApiKeyOverrideForTests / __setContentModelOverrideForTests / __setPiiModelOverrideForTests
 */

import {
  BUILDER_OPENROUTER_API_KEY,
  CONTENT_MODERATION_MODEL,
  PII_REDACTION_MODEL,
} from "@/config";
import logger from "@/utils/logger";
import {
  openRouterChatCompletion,
  type TraceContext,
} from "./openrouter-client";

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

/** Override `CONTENT_MODERATION_MODEL` for tests. Pass `null` to clear.
 *  Applies to both the content-safety and twitter-intent checks (they share
 *  the same model). */
export function __setContentModelOverrideForTests(model: string | null): void {
  _contentModelOverride = model;
}

// ---------------------------------------------------------------------------
// Test seam — singleton override pattern
// ---------------------------------------------------------------------------

let _contentOverride: ModerationOverride | null = null;
let _twitterIntentOverride: ModerationOverride | null = null;

/**
 * Install a test override for `checkContent`.
 * Pass `null` to restore normal behaviour.
 */
export function __resetModerationForTests(
  override: ModerationOverride | null,
): void {
  _contentOverride = override;
}

/**
 * Install a test override for `checkTwitterIntent`.
 * Pass `null` to restore normal behaviour.
 */
export function __resetTwitterIntentForTests(
  override: ModerationOverride | null,
): void {
  _twitterIntentOverride = override;
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

function buildTwitterIntentPrompt(input: string): string {
  return `You are an intent classifier for a Twitter bot that builds AI assistants when users @mention it with requests like "Build me a math tutor bot".

The input below has already passed a separate content-safety check; you are ONLY judging whether the user is genuinely asking the bot to BUILD AN AGENT.

Classify into exactly one of two categories:

- "agent_request": The user is requesting an AI agent / assistant / bot to be built. Examples: "Build me a math tutor", "Create a recipe assistant", "Make me a travel planner bot", "I need a bot that helps with coding".

- "not_agent_request": The content is something other than a build request. Examples: "follow me back", "retweet this", "hi", "good morning", "@bot what's up", "lol", generic greetings, requests for the bot to perform actions other than building agents.

Respond with ONLY the classification label, nothing else. No quotes, no explanation, no extra text.

Tweet text to classify:
${input}`;
}

function mapTwitterIntentLabel(label: string): ModerationResult {
  const trimmed = label.trim().toLowerCase();

  if (trimmed === "agent_request") {
    return { allowed: true };
  }
  if (trimmed === "not_agent_request") {
    return { allowed: false, reason: "not_agent_request" };
  }

  logger.warn(
    { label },
    "[moderation:twitter-intent] Unexpected classification label, failing open",
  );
  return { allowed: true };
}

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
export async function checkContent(
  input: string,
  trace?: TraceContext,
): Promise<ModerationResult> {
  if (_contentOverride) {
    return _contentOverride(input);
  }
  return _checkContent(input, trace);
}

/**
 * Twitter-only intent check. Runs after checkContent passes, only when
 * twitterContext is present on the request. Confirms the input is an
 * agent-build request vs. unrelated spam. Fails open on infrastructure errors.
 */
export async function checkTwitterIntent(
  input: string,
  trace?: TraceContext,
): Promise<ModerationResult> {
  if (_twitterIntentOverride) {
    return _twitterIntentOverride(input);
  }
  return _checkTwitterIntent(input, trace);
}

// ---------------------------------------------------------------------------
// Internal implementation
// ---------------------------------------------------------------------------

async function _checkContent(
  input: string,
  trace?: TraceContext,
): Promise<ModerationResult> {
  return _classify({
    input,
    promptBuilder: buildContentPrompt,
    labelMapper: mapContentLabel,
    model: getContentModel(),
    logTag: "[moderation:content]",
    stage: "moderation",
    trace,
  });
}

async function _checkTwitterIntent(
  input: string,
  trace?: TraceContext,
): Promise<ModerationResult> {
  return _classify({
    input,
    promptBuilder: buildTwitterIntentPrompt,
    labelMapper: mapTwitterIntentLabel,
    // Shares CONTENT_MODERATION_MODEL — same cheap-classifier knob.
    model: getContentModel(),
    logTag: "[moderation:twitter-intent]",
    stage: "twitter-intent",
    trace,
  });
}

interface ClassifyOptions {
  input: string;
  promptBuilder: (input: string) => string;
  labelMapper: (label: string) => ModerationResult;
  model: string;
  logTag: string;
  stage: "moderation" | "twitter-intent";
  trace?: TraceContext;
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

  try {
    // Routed through the OpenRouter client so the call emits a `$ai_generation`
    // into PostHog LLM Analytics (grouped under the generation's trace when a
    // trace context is supplied). Errors (HTTP, timeout, network) throw and are
    // caught below — moderation always fails open.
    const data = await openRouterChatCompletion({
      apiKey,
      stage: opts.stage,
      body: {
        model: opts.model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.1,
        max_tokens: 20,
      },
      timeoutMs: MODERATION_TIMEOUT_MS,
      trace: opts.trace,
    });

    const content = data.choices[0]?.message?.content;
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
  }
}

// ===========================================================================
// PII REDACTION — output scrub, fails CLOSED
//
// Runs at persist time over the generated template, not at the request-time
// moderation call above (the template doesn't exist yet at that point, and
// PDF/image-derived PII only surfaces in the generated output). Reuses the
// same API key + override seams; adds its own model knob.
// ===========================================================================

/** The free-text template fields scanned for PII. All optional so partial
 *  callers (e.g. a PATCH that only changes the prompt) pass just what they
 *  have; only provided string fields are scanned and returned. */
export interface RedactableFields {
  agentName?: string;
  description?: string;
  prompt?: string;
}

export type RedactableField = keyof RedactableFields;

/** One PII span the model located, scoped to the field it was found in. */
export interface PiiFinding {
  field: RedactableField;
  /** The exact substring to remove from `field`. */
  text: string;
  /** Category label (email, phone, person, address, …) — drives the mask. */
  type: string;
}

export interface RedactionResult {
  /** The fields with every finding masked. */
  fields: RedactableFields;
  findings: PiiFinding[];
}

export type PiiRedactionOverride = (
  fields: RedactableFields,
  signal?: AbortSignal,
  trace?: TraceContext,
) => Promise<RedactionResult>;

const PII_TIMEOUT_MS = 10_000;
const REDACTABLE_FIELDS: readonly RedactableField[] = [
  "agentName",
  "description",
  "prompt",
];

let _piiModelOverride: string | null = null;
let _piiOverride: PiiRedactionOverride | null = null;

function getPiiModel(): string {
  return _piiModelOverride ?? PII_REDACTION_MODEL;
}

/** Override `PII_REDACTION_MODEL` for tests. Pass `null` to clear. */
export function __setPiiModelOverrideForTests(model: string | null): void {
  _piiModelOverride = model;
}

/** Install a test override for `redactTemplatePii`. Pass `null` to restore. */
export function __resetPiiRedactionForTests(
  override: PiiRedactionOverride | null,
): void {
  _piiOverride = override;
}

function buildRedactionPrompt(fields: RedactableFields): string {
  const lines = REDACTABLE_FIELDS.filter(
    (k) => typeof fields[k] === "string",
  ).map((k) => `${k}: ${JSON.stringify(fields[k])}`);
  return `You are a PII detector for AI assistant templates that may be shared publicly with other users.

You are given fields of an assistant template. Find every span of personal/identifying information a person would not want shared: names of real people, email addresses, phone numbers, street/physical addresses, account/card/SSN/IBAN numbers, and similar identifiers.

Rules:
- Return the EXACT substring as it appears in the field (so it can be removed verbatim). Do not paraphrase or normalize it.
- Attribute each finding to the field it appears in: "agentName", "description", or "prompt".
- Do NOT flag generic role/topic words, brand/product names, or the assistant's own persona — only genuine personal data.
- If there is no PII, return an empty list.

Fields:
${lines.join("\n")}`;
}

const REDACTION_RESPONSE_FORMAT = {
  type: "json_schema" as const,
  json_schema: {
    name: "pii_findings",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        findings: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              field: {
                type: "string",
                enum: ["agentName", "description", "prompt"],
              },
              text: { type: "string" },
              type: { type: "string" },
            },
            required: ["field", "text", "type"],
          },
        },
      },
      required: ["findings"],
    },
  },
};

function maskFor(type: string): string {
  const label = (type || "redacted").trim().toUpperCase().replace(/\s+/g, "_");
  return `[${label}]`;
}

/** Remove every finding's exact text from its named field. Plain substring
 *  split/join (no regex) so special characters can't break the substitution,
 *  and a finding only ever touches the one field it was attributed to. */
export function applyFindings(
  fields: RedactableFields,
  findings: PiiFinding[],
): RedactableFields {
  const out: RedactableFields = { ...fields };
  for (const f of findings) {
    const cur = out[f.field];
    if (typeof cur !== "string" || !f.text) continue;
    out[f.field] = cur.split(f.text).join(maskFor(f.type));
  }
  return out;
}

/**
 * Scan and redact PII from the generated template fields. Fails CLOSED — any
 * error throws, and the executor turns that into a failed generation rather
 * than persisting un-scanned content.
 */
export async function redactTemplatePii(
  fields: RedactableFields,
  signal?: AbortSignal,
  trace?: TraceContext,
): Promise<RedactionResult> {
  if (_piiOverride) return _piiOverride(fields, signal, trace);

  const apiKey = getApiKey();
  if (!apiKey) {
    // Fail closed: by persist time the builder key must exist (generation
    // already used it), so a missing key here is a real misconfiguration —
    // surface it rather than persist unscanned content.
    throw new Error("[pii-redaction] BUILDER_OPENROUTER_API_KEY not set");
  }

  const data = await openRouterChatCompletion({
    apiKey,
    stage: "pii-redaction",
    body: {
      model: getPiiModel(),
      messages: [{ role: "user", content: buildRedactionPrompt(fields) }],
      temperature: 0,
      response_format: REDACTION_RESPONSE_FORMAT,
    },
    timeoutMs: PII_TIMEOUT_MS,
    signal,
    trace,
  });

  const content = data.choices[0]?.message?.content;
  if (!content) {
    throw new Error("[pii-redaction] empty LLM response");
  }

  const findings = parseFindings(content);
  const redacted = applyFindings(fields, findings);

  if (findings.length > 0) {
    logger.info(
      { count: findings.length },
      "[pii-redaction] redacted PII from generated template",
    );
  }

  return { fields: redacted, findings };
}

/** Parse + validate the model's JSON. Throws (fail-closed) on anything that
 *  isn't a well-formed findings array. */
function parseFindings(content: string): PiiFinding[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("[pii-redaction] response was not valid JSON");
  }

  const raw =
    typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>).findings
      : undefined;
  if (!Array.isArray(raw)) {
    throw new Error("[pii-redaction] response missing findings array");
  }

  const findings: PiiFinding[] = [];
  for (const item of raw) {
    // Fail closed on a malformed item: silently skipping it would drop a real
    // PII span and persist it unredacted, which defeats the whole stage.
    if (typeof item !== "object" || item === null) {
      throw new Error(
        "[pii-redaction] findings array contains a non-object item",
      );
    }
    const f = item as Record<string, unknown>;
    const { field, text, type } = f;
    if (
      typeof field !== "string" ||
      !REDACTABLE_FIELDS.includes(field as RedactableField) ||
      typeof text !== "string" ||
      typeof type !== "string"
    ) {
      throw new Error(
        "[pii-redaction] finding has invalid field, text, or type",
      );
    }
    findings.push({ field: field as RedactableField, text, type });
  }
  return findings;
}
