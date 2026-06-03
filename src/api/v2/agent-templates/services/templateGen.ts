/**
 * Template generation service — port of pool/src/services/skillGen.ts.
 *
 * URL detection → GitHub-passthrough → Exa (or Twitter oEmbed) →
 * content-classifier passthrough → main LLM call.
 * PDFs/images go straight to the multimodal call.
 * Text truncated to MAX_CONTENT_LENGTH = 10_000.
 * BREVITY_RAIL appended only on the production-LLM path (NOT on passthrough —
 * pool's asymmetry preserved verbatim).
 *
 * OpenRouter raw fetch to https://openrouter.ai/api/v1/chat/completions with
 * strict response_format json_schema, temp 0.7, no max_tokens.
 * Helper calls run at temp 0.2 without response_format: the GitHub-instructions
 * selector uses the main model; the content-classifier uses the cheap
 * BUILDER_CLASSIFIER_MODEL and passes content through on two routes: it is
 * ADDRESSED TO an agent (system prompt / install steps), OR it is a complete
 * multi-section agent specification (objective + mechanics + voice + scope), even
 * in the third person. A SHORT third-person brief that merely names what the
 * agent does, and human prose (article/essay/news) at any length, are source
 * material to design from. A deterministic structure gate fast-paths frontmatter
 * / distinctive section-header skill-defs ahead of the model.
 *
 * Soft defaults for non-name fields. Server-injects connections: [].
 */

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument */

import { APIConnectionTimeoutError, APIError, APIUserAbortError } from "openai";
import { z } from "zod";
import {
  BUILDER_CLASSIFIER_MODEL,
  BUILDER_EXA_SERVICE_KEY,
  BUILDER_MODEL,
  BUILDER_OPENROUTER_API_KEY,
} from "@/config";
import { AppError } from "@/utils/errors";
import { SYSTEM_PROMPT } from "../lib/system-prompt";
import {
  openRouterChatCompletion,
  withAiSpan,
  type TraceContext,
} from "./openrouter-client";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_CONTENT_LENGTH = 10_000;

/** The only tool values a generated template may use. Mirrors the SUPERPOWERS
 *  table + field requirements in `data/template-generator-prompt.txt`; the
 *  json_schema enum on the generate call enforces it at decode time so a custom
 *  builder prompt can't emit an unmappable tool. */
export const TEMPLATE_TOOLS = [
  "Search",
  "Browse",
  "Email",
  "Schedule",
] as const;

/** The category taxonomy a generated template may use. Single in-repo source for
 *  the json_schema enum below and the selector/classifier sub-stage prompts (and
 *  it mirrors the field-requirements line in `data/template-generator-prompt.txt`);
 *  the enum on the generate call enforces it at decode time so a custom builder
 *  prompt — or temperature drift — can't invent an off-taxonomy category. */
export const TEMPLATE_CATEGORIES = [
  "Sports & Rec",
  "Travel & Adventures",
  "Food & Dining",
  "Events & Occasions",
  "Hobbies & Interests",
  "Entertainment & Culture",
  "Music & Creative",
  "Kids & Family",
  "Wellness & Fitness",
  "Money & Investing",
  "Work",
  "Local",
  "Superpowers",
] as const;

// Concrete OpenRouter model id (not an OpenRouter `@preset/...` alias) so
// PostHog LLM Analytics can price `$ai_generation` events — `$ai_total_cost_usd`
// resolves automatically. Override per-environment with `BUILDER_MODEL`.
const DEFAULT_MODEL = "anthropic/claude-opus-4.7";

// Wallclock cap for every OpenRouter call (selector, classifier, main).
// Today both JSON and SSE handler modes share a single buffered completion,
// so the same wallclock cap covers both. If the runtime ever streams chunks
// from upstream, that path needs a separate per-chunk inactivity timer.
const OPENROUTER_TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------------------
// LLM error classification
// ---------------------------------------------------------------------------

/** True when the call timed out or was aborted (internal wallclock cap or an
 *  external cancellation signal). Mirrors the raw-fetch code's `AbortError`
 *  branch. */
function isTimeoutOrAbort(err: unknown): boolean {
  return (
    err instanceof APIConnectionTimeoutError || err instanceof APIUserAbortError
  );
}

/** True for an HTTP error *response* (4xx/5xx) — `APIError` carries a numeric
 *  `status`. Network/connection failures are `APIError` subclasses without a
 *  status; those are NOT "expected" and should propagate, matching the
 *  raw-fetch code where a non-`AbortError` rejection re-threw. */
function isHttpStatusError(err: unknown): err is APIError {
  return err instanceof APIError && typeof err.status === "number";
}

/** Helper LLM calls (selector, classifier) treat HTTP errors and
 *  timeouts/aborts as "no result, fall back to normal generation" (return
 *  null). Anything else (network failure, parse bug) propagates. */
function isExpectedHelperFailure(err: unknown): boolean {
  return isTimeoutOrAbort(err) || isHttpStatusError(err);
}

/** Short, log-friendly description of an LLM call failure. */
function describeLlmError(err: unknown): string {
  if (isTimeoutOrAbort(err)) {
    return `timed out/aborted (cap ${OPENROUTER_TIMEOUT_MS}ms)`;
  }
  if (isHttpStatusError(err)) return `HTTP ${err.status}`;
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Config-backed accessors (with test-only override seams)
// ---------------------------------------------------------------------------

let _apiKeyOverride: string | null | undefined = undefined;
let _builderModelOverride: string | null = null;
let _classifierModelOverride: string | null = null;
let _exaKeyOverride: string | null | undefined = undefined;
let _systemPromptOverride: string | null = null;

function getApiKey(): string | null {
  if (_apiKeyOverride !== undefined) return _apiKeyOverride;
  return BUILDER_OPENROUTER_API_KEY || null;
}

function getExaKey(): string | null {
  if (_exaKeyOverride !== undefined) return _exaKeyOverride;
  return BUILDER_EXA_SERVICE_KEY || null;
}

/** Read the model. Exported for the generate handler (needed for error-path
 *  PostHog metrics). */
export function getModel(): string {
  return _builderModelOverride ?? (BUILDER_MODEL || DEFAULT_MODEL);
}

/** Override `BUILDER_OPENROUTER_API_KEY` for tests.
 *  Pass a string to override, `null` to simulate "no API key set", or
 *  `undefined` to clear and fall back to config. */
export function __setBuilderApiKeyOverrideForTests(
  key: string | null | undefined,
): void {
  _apiKeyOverride = key;
}

/** Override `BUILDER_MODEL` for tests. Pass `null` to clear. */
export function __setBuilderModelOverrideForTests(model: string | null): void {
  _builderModelOverride = model;
}

/** Model for the passthrough classifier (`classifyPastedContent`) — a cheap
 *  model separate from the main `getModel()`. Override `BUILDER_CLASSIFIER_MODEL`. */
export function getClassifierModel(): string {
  return _classifierModelOverride ?? BUILDER_CLASSIFIER_MODEL;
}

/** Override `BUILDER_CLASSIFIER_MODEL` for tests. Pass `null` to clear. */
export function __setClassifierModelOverrideForTests(
  model: string | null,
): void {
  _classifierModelOverride = model;
}

/** The system prompt actually used for generation — the loaded file unless an
 *  override is installed. */
function getSystemPrompt(): string | null {
  return _systemPromptOverride ?? SYSTEM_PROMPT;
}

/** Override the generator system prompt (e.g. to A/B a base-branch vs PR version
 *  of data/template-generator-prompt.txt in an eval). Pass `null` to clear. */
export function __setSystemPromptOverrideForTests(prompt: string | null): void {
  _systemPromptOverride = prompt;
}

/** Override `BUILDER_EXA_SERVICE_KEY` for tests. Pass `null` to simulate "unset",
 *  `undefined` to clear and fall back to config. */
export function __setExaKeyOverrideForTests(
  key: string | null | undefined,
): void {
  _exaKeyOverride = key;
}

// Appended to every generated template prompt (and to the passthrough rail)
// so the brevity + artifact-escape reminder sits at the trailing edge of the
// prompt, where the model's attention lands when drafting a reply. Runtime
// BREVITY.md handles the per-turn rail; this duplicates the rule inside the
// template definition itself because generated templates are long (BRAIN /
// SOUL / HEART / SCHEDULE + worked examples) and drown out the earlier rail.
const BREVITY_RAIL = `## Runtime Reminder

Chat replies appear as push notifications on members' phones. Hard cap: 3 sentences, plain text — no markdown, bullets, headers, or links. When the answer is reference-worthy (plan, guide, comparison, itinerary, summary, rundown, breakdown), write a file to your workspace and send it with MEDIA:./filename.html — Convos artifacts are HTML, never .md, and you must run the \`artifact\` skill before writing any .html file (it owns the design system: DESIGN.md, Note vs Table, head-meta, light/dark). The 3-sentence cap applies to the short chat message next to the artifact, not the file itself. Default to a single short paragraph. If two thoughts truly need to land apart, separate them with a **blank line** (double line break, \`\\n\\n\`) — a single newline glues them into one bubble, which is almost never what you want.`;

// Appended to a custom builder-prompt override (the admin tool) — never to the
// canonical prompt, which already carries this guidance. The JSON *shape* is
// enforced by the response schema regardless, so this rail only re-asserts the
// field *quality* the schema can't check (a real name/emoji, no empties) — the
// part a custom prompt is most likely to drop. Goes LAST so a long custom
// prompt can't bury it (mirrors BREVITY_RAIL on the agent prompt).
const BUILDER_CONTRACT_RAIL = `## Field Requirements (non-negotiable)

The builder instructions above design the agent, and the output JSON shape is
already enforced by the response schema. Regardless of those instructions, fill
every field with a real, fitting value — never blank, placeholder, or "TODO":

- agentName — a memorable 1–3 word handle that fits the agent's vibe. Never "Assistant", "Bot", "Helper", or a descriptive title.
- emoji — exactly one glyph that fits the agent. Never blank.
- description — one line (≤140 chars) on what the agent is for.
- category — one sensible category.
- tools — only the tools the agent actually needs.
- prompt — the agent's full instructions; never empty.`;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GeneratedTemplate {
  agentName: string;
  description: string;
  prompt: string;
  category: string;
  emoji: string;
  tools: string[];
  connections: string[];
}

/** Metrics from the OpenRouter LLM call — used for PostHog metering. */
export interface GenerationMetrics {
  model: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
}

/** Return type for `callGenerateTemplate` — template + LLM metrics. */
export interface GenerationResult {
  template: GeneratedTemplate;
  metrics: GenerationMetrics;
}

/** Token usage from helper LLM calls (selector, classifier) used in
 *  passthrough paths so PostHog metering reflects actual cost. */
interface PassthroughTokens {
  promptTokens: number;
  completionTokens: number;
}

interface PassthroughBundle {
  template: GeneratedTemplate;
  /** Model that produced `tokens` — the selector (`getModel()`) for a GitHub
   *  repo scan, or the classifier (`getClassifierModel()`) for pasted content
   *  and direct GitHub file links. Carried so passthrough metrics attribute
   *  cost to the model actually billed, not the main generation model. */
  model: string;
  tokens: PassthroughTokens;
}

/** Result of GitHub URL pre-fetch. `passthrough` means we have a ready
 *  template; `rawContent` means we fetched the user-pointed file but the
 *  classifier didn't flag it as agent-ready — caller should use the content
 *  as source material instead of re-extracting from the original URL (which
 *  would scrape GitHub's HTML viewer page). */
type GithubPrefetch =
  | { kind: "passthrough"; bundle: PassthroughBundle }
  | { kind: "rawContent"; content: string };

/** Convenience constant for test mocks — realistic placeholder metrics. */
export const DEFAULT_TEST_METRICS: GenerationMetrics = {
  model: "anthropic/claude-opus-4.7",
  promptTokens: 100,
  completionTokens: 200,
  latencyMs: 1500,
};

export interface GenerateTemplateInput {
  /** What the user typed in the composer. When sent alone, URL-shaped
   *  text is auto-extracted; everything else flows through the standard
   *  text generation path. When sent alongside a file (pdfBase64 /
   *  imageBase64), the file is the source material and `text` is the
   *  user's intent / directive about how to use it. The HTTP route
   *  handler coalesces legacy `idea` / `content` / `url` fields from
   *  older clients into this single field at the API boundary. */
  text?: string;
  /** Base64-encoded PDF content. */
  pdfBase64?: string;
  /** Base64-encoded image content. */
  imageBase64?: string;
  /** MIME type for images (e.g. "image/png"). */
  mimeType?: string;
  /** Optional filename for the uploaded document. */
  filename?: string;
}

/** Caller-pinned identity fields (mirror of the generation row's `prefill`
 *  column; see `applyPrefill` in generation-executor). Fed INTO the generator
 *  so the produced agentName, prompt body, and WELCOME MESSAGE use the pinned
 *  name rather than a model-invented one that the persist-stage metadata
 *  overlay would then silently contradict. */
export interface GenerationPrefill {
  agentName?: string;
  emoji?: string;
  description?: string;
}

/** Build the user-message addendum that pins the assistant's identity. Returns
 *  "" when nothing identity-shaped was pinned — `description` alone is not an
 *  identity the prompt body must echo (it's overlaid as metadata at persist). */
function buildIdentityDirective(prefill?: GenerationPrefill | null): string {
  if (!prefill) return "";
  const name = prefill.agentName?.trim();
  const emoji = prefill.emoji?.trim();
  const parts: string[] = [];
  if (name) parts.push(`name: "${name}"`);
  if (emoji) parts.push(`emoji: "${emoji}"`);
  if (parts.length === 0) return "";
  // The closing clause depends on whether a name was pinned: with a name, the
  // whole persona must read as it; emoji-only pins just the glyph and leaves
  // the model free to name the assistant (so "this name" would be a dangling
  // reference).
  const closing = name
    ? `The "agentName" you return MUST equal this name, and the prompt body, every ` +
      `self-reference, and the WELCOME MESSAGE must read as this named assistant.`
    : `The "emoji" you return MUST equal this emoji; you may choose a name and ` +
      `persona that fit it.`;
  return (
    `\n\nREQUIRED IDENTITY — the user has already pinned part of this assistant's identity. ` +
    `Use these exact values; do NOT substitute different ones: ${parts.join(", ")}. ` +
    closing
  );
}

// ---------------------------------------------------------------------------
// Brevity rail helper — exported for testing
// ---------------------------------------------------------------------------

/** Append the Runtime Reminder rail to a generated template's prompt. Exported for testing. */
export function appendBrevityRail(
  template: GeneratedTemplate,
): GeneratedTemplate {
  return {
    ...template,
    prompt: `${template.prompt}\n\n---\n\n${BREVITY_RAIL}`,
  };
}

// ---------------------------------------------------------------------------
// URL detection — exported for tests
// ---------------------------------------------------------------------------

/** Detect a URL-shaped text input. Trimmed leading/trailing whitespace
 *  to be tolerant of pasted content. Exported for tests. */
export function looksLikeUrl(text: string): boolean {
  return /^https?:\/\//i.test(text.trim());
}

// ---------------------------------------------------------------------------
// URL extraction helpers
// ---------------------------------------------------------------------------

/** Check if a URL is an X/Twitter post. */
function isTwitterUrl(url: string): boolean {
  return /^https?:\/\/(x\.com|twitter\.com)\/\w+\/status\/\d+/i.test(url);
}

/** Extract content from a URL using Exa's /contents API. */
async function extractViaExa(
  url: string,
  trace?: TraceContext,
): Promise<string> {
  const exaKey = getExaKey();
  if (!exaKey) {
    throw new Error("BUILDER_EXA_SERVICE_KEY not configured");
  }

  return withAiSpan(
    trace,
    "exa.contents",
    { url },
    async () => {
      const res = await fetch("https://api.exa.ai/contents", {
        method: "POST",
        headers: {
          "x-api-key": exaKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ urls: [url], text: true }),
        signal: AbortSignal.timeout(30_000),
      });

      if (!res.ok) {
        const errText = await res.text();
        console.error(
          "[templateGen] Exa error:",
          res.status,
          errText.slice(0, 300),
        );
        throw new Error(`Exa content extraction failed (${res.status})`);
      }

      const data = (await res.json()) as any;
      const result = data?.results?.[0];
      if (!result?.text) {
        throw new Error("Exa returned no content for this URL");
      }
      return result.text as string;
    },
    (text) => ({ chars: text.length }),
  );
}

/** Extract tweet content via oEmbed, following any embedded links. */
async function extractViaTweetOEmbed(
  url: string,
  trace?: TraceContext,
): Promise<string> {
  return withAiSpan(
    trace,
    "twitter.oembed",
    { url },
    () => extractViaTweetOEmbedInner(url, trace),
    (out) => ({ chars: out.length }),
  );
}

async function extractViaTweetOEmbedInner(
  url: string,
  trace?: TraceContext,
): Promise<string> {
  const oembedUrl = `https://publish.twitter.com/oembed?url=${encodeURIComponent(url)}`;
  const res = await fetch(oembedUrl, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Twitter oEmbed failed (${res.status})`);

  const data = (await res.json()) as any;
  const author = data.author_name || "";
  const tweetText = (data.html || "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&mdash;/g, "—")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

  // Enrich tweet content with any linked pages by passing the t.co URLs
  // directly to Exa. Exa resolves redirects internally, so we never fetch a
  // user-supplied (or user-redirected) URL from our own server — matching the
  // "we don't fetch user URLs" pattern established when the direct-fetch
  // fallback was removed in edf2503.
  //
  // Trust boundary: the URLs handed to Exa here come from a third-party
  // tweet, not from the requesting user. A malicious tweet author could
  // include a t.co link that redirects to an internal-to-Exa endpoint (e.g.
  // cloud metadata). The SSRF surface on OUR network is closed — we make no
  // outbound request to the t.co URL — but Exa does fetch it on its own
  // infrastructure. We accept that posture because Exa exists to fetch
  // user-supplied URLs as its product (the main URL flow at extractUrl()
  // does the same with the user's own typed URL), and the residual blast
  // radius is on Exa's side, not ours.
  //
  // Trade-off: we lose the `isTwitterUrl(realUrl)` dedupe on links that
  // redirect back to twitter.com; Exa returns the underlying tweet content
  // in that case, which is harmless (the outer tweet's text is already
  // included by oEmbed above).
  const tcoLinks = (data.html || "").match(/https?:\/\/t\.co\/\w+/g) || [];
  let linkedContent = "";
  for (const tco of tcoLinks.slice(0, 3)) {
    try {
      const pageContent = await extractViaExa(tco, trace);
      linkedContent += `\n\n--- Linked content from ${tco} ---\n${pageContent}`;
    } catch {
      // skip
    }
  }

  const parts = [`Tweet by ${author}:\n${tweetText}`];
  if (linkedContent) parts.push(linkedContent);
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// GitHub repo detection — agent install instructions passthrough
// ---------------------------------------------------------------------------

/**
 * Parse a GitHub URL.
 *
 * Recognises both repo roots (`/owner/repo`) and file-blob URLs
 * (`/owner/repo/blob/<branch>/<path>`). When `filePath` is set, the caller
 * should fetch that file directly instead of asking an LLM to pick something
 * out of the repo tree.
 */
function parseGithubRepoUrl(
  url: string,
): { owner: string; repo: string; branch?: string; filePath?: string } | null {
  try {
    const u = new URL(url);
    if (!/^(www\.)?github\.com$/i.test(u.hostname)) return null;
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts.length < 2) return null;
    const owner = parts[0];
    const repo = parts[1].replace(/\.git$/, "");
    if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) return null;

    // /owner/repo/blob/<branch>/<...path> — direct file link.
    if (parts[2] === "blob" && parts.length >= 5) {
      return {
        owner,
        repo,
        branch: parts[3],
        filePath: parts.slice(4).join("/"),
      };
    }

    return { owner, repo };
  } catch {
    return null;
  }
}

async function githubApiGet(path: string, trace?: TraceContext): Promise<any> {
  return withAiSpan(trace, "github.api", { path }, async () => {
    const res = await fetch(`https://api.github.com${path}`, {
      headers: {
        "User-Agent": "Convos-TemplateGen/1.0",
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      throw new Error(`GitHub API ${path} returned ${res.status}`);
    }
    return res.json();
  });
}

/** Fetch the raw content of a file in a repo at its default branch.
 *
 *  `optional` is for files the caller treats as "nice to have" (e.g. README):
 *  a missing/unreachable file resolves to `""` and the span records
 *  `{ found: false }` rather than an error — a missing README is an expected
 *  outcome, not a failure worth flagging red in the trace UI. Required fetches
 *  (`optional` omitted) still throw so callers can fall back. */
async function githubFetchRaw(
  owner: string,
  repo: string,
  branch: string,
  path: string,
  trace?: TraceContext,
  optional = false,
): Promise<string> {
  return withAiSpan(
    trace,
    "github.raw",
    { path },
    async () => {
      const url = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) {
        if (optional) return "";
        throw new Error(`Failed to fetch ${url} (${res.status})`);
      }
      return res.text();
    },
    (text) => ({ chars: text.length, found: text.length > 0 }),
  );
}

type PassthroughType = "install-instructions" | "skill-definition";

interface PassthroughMetadata {
  agentName: string;
  emoji: string;
  description: string;
  category: string;
}

/** Wrap raw agent-oriented content with a Convos runtime preamble and return a GeneratedTemplate. */
function wrapAsPassthroughTemplate(
  rawContent: string,
  metadata: PassthroughMetadata,
  type: PassthroughType,
): GeneratedTemplate {
  const rails = `## Convos Runtime Context

You are running inside a Convos group chat, not a standalone terminal session.

- Do not mention framework names (Hermes, OpenClaw, Claude, etc.) — you are a Convos agent.
- Ask the user for any secrets (API keys, tokens). Never hardcode or persist them anywhere shared.`;

  const typeSpecific =
    type === "install-instructions"
      ? `
- Your terminal, file, and code_execution tools are available to perform clone/install/configure steps described above.
- Follow the instructions above on first message. Report progress concisely (one line per step). When setup is complete, say "Setup done — what would you like to work on?" and wait for the user.`
      : `
- The content above is your full behavioral brief — adopt that identity and follow those instructions throughout the conversation.`;

  const prompt = `${rawContent}

---

${rails}${typeSpecific}

${BREVITY_RAIL}`;

  return {
    agentName: metadata.agentName,
    description: metadata.description,
    prompt,
    category: metadata.category,
    emoji: metadata.emoji,
    tools: ["Search", "Browse", "Schedule"],
    connections: [],
  };
}

interface GithubInstructionSelection {
  hasAgentInstructions: boolean;
  passthroughType: PassthroughType | null;
  instructionsPath: string | null;
  embeddedContent: string | null;
  agentName: string | null;
  emoji: string | null;
  description: string | null;
  category: string | null;
}

/** Ask the LLM to locate agent install instructions in a repo and produce metadata. */
async function selectInstructionsViaLLM(
  owner: string,
  repo: string,
  repoDescription: string,
  tree: string[],
  readme: string,
  externalSignal?: AbortSignal,
  trace?: TraceContext,
): Promise<{
  selection: GithubInstructionSelection;
  tokens: PassthroughTokens;
} | null> {
  const apiKey = getApiKey();
  if (!apiKey) return null;

  const filteredTree = tree
    .filter((p) => {
      if (p.endsWith("/")) return false;
      const lower = p.toLowerCase();
      if (
        lower.endsWith(".md") ||
        lower.endsWith(".mdx") ||
        lower.endsWith(".txt")
      )
        return true;
      if (
        lower.includes("agent") ||
        lower.includes("claude") ||
        lower.includes("ai")
      )
        return true;
      if (
        lower.endsWith(".yml") ||
        lower.endsWith(".yaml") ||
        lower.endsWith(".json")
      )
        return true;
      return false;
    })
    .slice(0, 100);

  const truncatedReadme = readme.slice(0, 5_000);

  const selectorPrompt = `You are analyzing a GitHub repo to determine if it ships agent-ready content that should be used VERBATIM as the prompt for a new AI agent — not as source material to generate a new agent from.

Repo: ${owner}/${repo}
Description: ${repoDescription || "(none)"}

Relevant files in the repo:
${filteredTree.map((p) => `- ${p}`).join("\n")}

README.md excerpt:
---
${truncatedReadme}
---

TASK — decide if the repo ships one of TWO kinds of agent-ready content, and if so, locate it:

Type A — install-instructions: setup choreography addressed to an AI agent
- Typical files: INSTALL_FOR_AGENTS.md, AGENTS.md, AI_SETUP.md, CLAUDE.md, .claude/instructions.md, docs/agents.md
- Or an embedded README section like "## For AI Agents", "## Installation (for agents)", "## Agent Setup"
- Contains steps like git clone, npm/bun install, API key setup, skill adoption — addressed TO an agent ("Read this, then follow the steps", "Ask the user for X")
- NOT a generic user/developer install guide

Type B — skill-definition: a complete system prompt already written for an agent
- Typical files: SKILL.md, skills/*/SKILL.md, a standalone system prompt markdown
- Often has YAML frontmatter with name: and description:
- Written as direct instructions to an AI ("You are...", "You must...", "Your job is to...")
- Could also be an existing Convos-style skill with BRAIN/SOUL/HEART sections

If you find either kind, also produce metadata based on the README + repo:
- agentName: a creative memorable name derived from the repo (e.g. "garrytan/gbrain" → "GBrain 🧠" style)
- emoji: single emoji that fits
- description: 1-2 sentence third-person description
- category: one of: ${TEMPLATE_CATEGORIES.join(", ")}

Respond with ONLY a JSON object (no markdown fences, no explanation):

{
  "hasAgentInstructions": true|false,
  "passthroughType": "install-instructions" | "skill-definition" | null,
  "instructionsPath": "path/to/file.md" | null,
  "embeddedContent": "the exact extracted section text if embedded in README (including headers)" | null,
  "agentName": string | null,
  "emoji": string | null,
  "description": string | null,
  "category": string | null
}

Rules:
- If hasAgentInstructions is false, all other fields MUST be null.
- Prefer instructionsPath over embeddedContent when a dedicated file exists.
- Never return both instructionsPath and embeddedContent — pick one.
- If you're unsure whether content is "for agents" vs "source material about a topic", lean toward false. Better to fall back to generation than to pass through a human-oriented README.`;

  const t0 = performance.now();
  let data: any;
  try {
    data = await openRouterChatCompletion({
      apiKey,
      stage: "selector",
      body: {
        model: getModel(),
        messages: [{ role: "user", content: selectorPrompt }],
        temperature: 0.2,
      },
      signal: externalSignal,
      timeoutMs: OPENROUTER_TIMEOUT_MS,
      trace,
    });
  } catch (err) {
    if (isExpectedHelperFailure(err)) {
      console.error(
        "[templateGen] GitHub selector LLM failed:",
        describeLlmError(err),
      );
      return null;
    }
    throw err;
  }

  console.log(
    `[templateGen] selectInstructions ok: model=${data?.model}, latencyMs=${Math.round(performance.now() - t0)}, prompt=${data?.usage?.prompt_tokens}, completion=${data?.usage?.completion_tokens}`,
  );
  const tokens: PassthroughTokens = {
    promptTokens: Number(data?.usage?.prompt_tokens ?? 0),
    completionTokens: Number(data?.usage?.completion_tokens ?? 0),
  };
  const content = data?.choices?.[0]?.message?.content;
  if (!content) return null;

  try {
    const cleaned = content
      .replace(/^```json?\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();
    const parsed = JSON.parse(cleaned);
    return {
      selection: parsed as GithubInstructionSelection,
      tokens,
    };
  } catch {
    const match = content.match(/\{[\s\S]*"hasAgentInstructions"[\s\S]*\}/);
    if (match) {
      try {
        return {
          selection: JSON.parse(match[0]) as GithubInstructionSelection,
          tokens,
        };
      } catch {
        /* fall through */
      }
    }
    console.error(
      "[templateGen] Failed to parse GitHub selector response:",
      content.slice(0, 300),
    );
    return null;
  }
}

/**
 * For a GitHub repo URL, detect if the repo ships agent install instructions and
 * return a ready-to-use template with those instructions as the prompt. Returns null
 * if the repo doesn't have such instructions — caller should fall back to normal
 * content-based generation.
 */
async function tryGithubPassthrough(
  url: string,
  externalSignal?: AbortSignal,
  trace?: TraceContext,
): Promise<GithubPrefetch | null> {
  const parsed = parseGithubRepoUrl(url);
  if (!parsed) return null;
  const { owner, repo, filePath, branch: explicitBranch } = parsed;

  // Direct file link: fetch the raw file and run it through
  // tryContentPassthrough so the user-selected file is used verbatim.
  if (filePath) {
    const branch = explicitBranch || "main";
    let content: string;
    try {
      content = await githubFetchRaw(owner, repo, branch, filePath, trace);
    } catch (err: any) {
      console.error(
        `[templateGen] Failed to fetch ${owner}/${repo}/${filePath}:`,
        err.message,
      );
      return null;
    }
    const bundle = await tryContentPassthrough(content, externalSignal, trace);
    if (bundle) return { kind: "passthrough", bundle };
    // Classifier said this isn't agent-ready, but the user linked directly
    // at the file — hand the raw content back to the caller so it can be
    // used as source material. Without this, generateTemplate would fall
    // through to extractUrl(blobUrl), which scrapes the GitHub HTML viewer.
    return { kind: "rawContent", content };
  }

  let repoInfo: any;
  try {
    repoInfo = await githubApiGet(`/repos/${owner}/${repo}`, trace);
  } catch (err: any) {
    console.error("[templateGen] GitHub repo lookup failed:", err.message);
    return null;
  }

  const branch = repoInfo.default_branch || "main";
  const repoDescription = repoInfo.description || "";

  // Fetch tree + README in parallel
  let tree: string[] = [];
  let readme = "";
  try {
    const [treeData, readmeRaw] = await Promise.all([
      githubApiGet(
        `/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`,
        trace,
      ),
      // README is optional: a missing one resolves to "" with a clean
      // (non-error) span. The outer .catch only covers rare transport errors.
      githubFetchRaw(owner, repo, branch, "README.md", trace, true).catch(
        () => "",
      ),
    ]);
    tree = (treeData.tree || []).map((t: any) => t.path).filter(Boolean);
    readme = readmeRaw;
  } catch (err: any) {
    console.error("[templateGen] Failed to fetch repo tree:", err.message);
    return null;
  }

  // Ask LLM to locate agent instructions + produce metadata
  const selectorResult = await selectInstructionsViaLLM(
    owner,
    repo,
    repoDescription,
    tree,
    readme,
    externalSignal,
    trace,
  );
  if (!selectorResult?.selection.hasAgentInstructions) return null;
  const { selection, tokens: selectorTokens } = selectorResult;

  // Resolve the instruction content
  let instructions: string;
  if (selection.instructionsPath) {
    try {
      instructions = await githubFetchRaw(
        owner,
        repo,
        branch,
        selection.instructionsPath,
        trace,
      );
    } catch (err: any) {
      console.error(
        `[templateGen] Failed to fetch ${selection.instructionsPath}:`,
        err.message,
      );
      return null;
    }
  } else if (selection.embeddedContent) {
    instructions = selection.embeddedContent;
  } else {
    return null;
  }

  const type: PassthroughType =
    selection.passthroughType === "skill-definition"
      ? "skill-definition"
      : "install-instructions";

  const template = wrapAsPassthroughTemplate(
    instructions,
    {
      agentName: selection.agentName || repo,
      description:
        selection.description ||
        repoDescription ||
        `Assistant based on ${owner}/${repo}.`,
      category: selection.category || "Work",
      emoji: selection.emoji || "📦",
    },
    type,
  );

  return {
    kind: "passthrough",
    bundle: { template, model: getModel(), tokens: selectorTokens },
  };
}

// ---------------------------------------------------------------------------
// Pasted content passthrough — detect when user-pasted content IS agent
// instructions or a skill definition, and use it verbatim
// ---------------------------------------------------------------------------

const PASSTHROUGH_MIN_LENGTH = 300;

interface ContentPassthroughResult {
  isPassthrough: boolean;
  passthroughType: PassthroughType | null;
  agentName: string | null;
  emoji: string | null;
  description: string | null;
  category: string | null;
}

// Strict validation of the classifier's JSON. A raw `as` cast would let a model
// that returns isPassthrough: "false" (a STRING) slip through as truthy and route
// a design case to verbatim passthrough — the exact bug class this PR fixes. So
// validate the shape; on any mismatch the caller falls back to design (the safe
// direction — never wrongly passthrough). isPassthrough must be a real boolean.
const ContentPassthroughResultSchema = z.object({
  isPassthrough: z.boolean(),
  passthroughType: z
    .enum(["install-instructions", "skill-definition"])
    .nullish(),
  agentName: z.string().nullish(),
  emoji: z.string().nullish(),
  description: z.string().nullish(),
  category: z.string().nullish(),
});

/** Parse + validate the classifier's JSON, normalizing missing fields to null.
 *  Returns null on parse error or schema mismatch (caller designs from source). */
function parseClassifierResult(json: string): ContentPassthroughResult | null {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  const parsed = ContentPassthroughResultSchema.safeParse(raw);
  if (!parsed.success) return null;
  const c = parsed.data;
  return {
    isPassthrough: c.isPassthrough,
    passthroughType: c.passthroughType ?? null,
    agentName: c.agentName ?? null,
    emoji: c.emoji ?? null,
    description: c.description ?? null,
    category: c.category ?? null,
  };
}

function cleanScalar(v: string): string | null {
  const s = v
    .trim()
    .replace(/^["']|["']$/g, "")
    .trim();
  return s.length ? s : null;
}

/**
 * High-precision structural detector for pasted content that is unmistakably a
 * skill-definition — YAML frontmatter with a `name:` key, or a block of the
 * all-caps section headers our skill format uses (BRAIN / SOUL / THE HOOK /
 * WELCOME MESSAGE …). When present, the content is agent-shaped beyond doubt,
 * so the caller classifies it passthrough deterministically and skips the LLM
 * classifier (cheaper, and not at the mercy of a flaky model on the easy case).
 *
 * The bar is deliberately strict: a false positive here would use SOURCE
 * MATERIAL verbatim as a system prompt — the exact failure we are guarding
 * against — so loose signals (a lone markdown `#` heading, or an article that
 * happens to contain the word "RULES") must NOT trigger it. Those defer to the
 * LLM's addressed-to-vs-about judgment. Exported so the classifier eval's
 * deterministic variant exercises this exact gate.
 *
 * Returns the metadata readable straight from the structure (name/description
 * from frontmatter), or null when the content is not structured.
 */
export function detectStructuredSkillDefinition(
  content: string,
): { agentName: string | null; description: string | null } | null {
  // 1) Leading YAML frontmatter block with a name: key.
  const fm =
    /^\uFEFF?\s*---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(
      content,
    );
  if (fm) {
    const block = fm[1];
    const nameMatch = /^[ \t]*name[ \t]*:[ \t]*(.+?)[ \t]*$/m.exec(block);
    if (nameMatch) {
      const descMatch = /^[ \t]*description[ \t]*:[ \t]*(.+?)[ \t]*$/m.exec(
        block,
      );
      return {
        agentName: cleanScalar(nameMatch[1]),
        description: descMatch ? cleanScalar(descMatch[1]) : null,
      };
    }
  }

  // 2) A block of the DISTINCTIVE all-caps section headers our skill format
  //    uses. Require >= 2 distinct standalone header lines so one stray all-caps
  //    word in prose can't trip the gate. Only headers that don't collide with
  //    ordinary human documents qualify — generic words like RULES / TONE /
  //    GUIDELINES / PERSONA / IDENTITY appear as all-caps headers in brand style
  //    guides, HR docs, and wikis (verified: a TONE+RULES style guide tripped
  //    the gate), so they are excluded here. A real skill-definition in our
  //    format has BRAIN/SOUL/HEART/THE HOOK/WELCOME MESSAGE anyway; one that
  //    only uses RULES/TONE still routes to the LLM, which classifies it
  //    correctly as agent-addressed.
  const SECTIONS = new Set([
    "BRAIN",
    "SOUL",
    "HEART",
    "THE HOOK",
    "WELCOME MESSAGE",
  ]);
  const hits = new Set<string>();
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine
      .replace(/^[#>\s*_]+/, "")
      .replace(/[\s*_:#]+$/, "")
      .trim();
    if (line && SECTIONS.has(line)) hits.add(line);
  }
  if (hits.size >= 2) return { agentName: null, description: null };

  return null;
}

/** Classify pasted content: is it agent-ready, or source material to generate from?
 *  Exported so the Braintrust classifier eval (tests/evals/classifier.ts) drives
 *  the exact production prompt + parse path on the real model. */
export async function classifyPastedContent(
  content: string,
  externalSignal?: AbortSignal,
  trace?: TraceContext,
): Promise<{
  classification: ContentPassthroughResult;
  tokens: PassthroughTokens;
} | null> {
  const apiKey = getApiKey();
  if (!apiKey) return null;

  const truncated = content.slice(0, 8_000);

  // Deterministic fast-path: unmistakably-structured skill definitions
  // (frontmatter / our section headers) are passthrough without consulting the
  // LLM — high precision, and it can't be flipped by a flaky classifier model.
  // Everything unstructured (third-person briefs, install steps, imperative
  // prose) falls through to the addressed-to-vs-about LLM judgment below.
  const structured = detectStructuredSkillDefinition(truncated);
  if (structured) {
    return {
      classification: {
        isPassthrough: true,
        passthroughType: "skill-definition",
        agentName: structured.agentName,
        emoji: null,
        description: structured.description,
        category: null,
      },
      tokens: { promptTokens: 0, completionTokens: 0 },
    };
  }

  const classifierPrompt = `You are classifying pasted text to decide if it should be used VERBATIM as the prompt for a new AI agent, or treated as source material to design an agent from.

Pasted content:
---
${truncated}
---

Decide whether the text is a FINISHED agent definition (use VERBATIM — passthrough) or RAW MATERIAL to design an agent from (re-generate). TWO different things make content passthrough:

PASSTHROUGH ROUTE 1 — AGENT-ADDRESSED: written and ADDRESSED TO an AI agent (any length).
- Type A — install-instructions: setup choreography addressed to an AI — "Read this, then…", "Ask the user for API keys", git clone / npm install / export env, clone → configure → adopt skills → report progress.
- Type B — skill-definition: a system prompt addressed to the agent — YAML frontmatter (name:/description:), "You are…", "You must…", "Always/Never…", a persona plus behavioral rules, section headers like BRAIN/SOUL/HEART, THE HOOK, WELCOME MESSAGE.

PASSTHROUGH ROUTE 2 — COMPLETE AGENT SPECIFICATION: a fully-developed document that SPECIFIES the whole agent across multiple sections — its objective/goal, concrete mechanics (the state it tracks, its triggers, the step-by-step actions/loops it runs), scheduled behavior, voice/persona, AND capability scope/limits. The bar is DEPTH, not breadth: the document must actually SPECIFY HOW each part works — the concrete rules, the exact triggers, the step-by-step loop, the named state — not merely NAME the capabilities. Naming five features in one clause each is breadth (a brief); spelling out how each one operates is depth (a specification). A document this developed was deliberately authored as the agent's definition; preserve it — EVEN WHEN it narrates in the third person ("the agent does X", "Player goal:…") or calls itself a "brief". Depth and completeness, not grammatical person, decide this route.

DESIGN (isPassthrough false) — RAW MATERIAL to design from:
- A SHORT brief or idea: a few sentences or a feature LIST that NAMES what the agent should do without specifying HOW each part works — e.g. "Coordinates tee times, polls the group, manages RSVPs, sends reminders. Friendly, laid-back golf-buddy personality." This NAMES an objective, mechanics, and a persona, but it specifies none of them — that breadth-without-depth is a brief, NOT a definition. Naming a persona, a voice, or a feature list does not make it a specification.
- Human prose not authored as an agent definition — an article, essay, news story, README-for-humans, marketing/landing copy, a product spec written for people, or a book/transcript excerpt — at ANY length (a long, sectioned article is still source material).

Decisive cues:
- Depth, not breadth: a feature list that NAMES the agent's objective, mechanics, and persona is still a brief (→ design) if it does not SPECIFY how each works. "Polls the group, manages RSVPs, sends reminders" names three features → brief. "Tuesday: DM the A-team first; once the lineup hits a multiple of 4, post to the group; on a bail, DM the top of the waitlist" specifies the mechanics → specification.
- For third-person text, ask: does this SPECIFY the agent (the actual rules, triggers, and loops), or merely DESCRIBE/NAME what it would do? Specifies → passthrough; describes/names → design.
- Human-prose genres (article/essay/news/marketing/book) are always design, however long or sectioned.

Example — DESIGN (isPassthrough false): "A friendly running coach that builds weekly training plans, tracks the runner's mileage, and sends a Monday check-in." (a short third-person brief → design it).
Example — PASSTHROUGH (isPassthrough true): "You are Coach. Build the user a weekly training plan. Always open with a Monday check-in. Never shame a missed run." (addressed to the agent).
Example — PASSTHROUGH (isPassthrough true): a multi-section document laying out the agent's objective function, the state/triggers/actions it runs, its scheduled sends, its voice/persona, and its capability scope — even titled "…Builder Brief" and written about "the agent" (a complete specification → preserve it).

If passthrough, also produce metadata:
- agentName: memorable name derived from the content
- emoji: single emoji that fits
- description: 1-2 sentence third-person description
- category: one of: ${TEMPLATE_CATEGORIES.join(", ")}

Respond with ONLY a JSON object (no markdown fences, no explanation):

{
  "isPassthrough": true|false,
  "passthroughType": "install-instructions" | "skill-definition" | null,
  "agentName": string | null,
  "emoji": string | null,
  "description": string | null,
  "category": string | null
}

Rules:
- If isPassthrough is false, all other fields MUST be null.
- Two routes to passthrough: (1) the text is ADDRESSED TO the agent (second-person/imperative, YAML frontmatter, install steps), OR (2) it is a COMPLETE multi-section agent specification (objective + mechanics + voice + scope), even if written in the third person. A SHORT third-person brief/idea, or human-prose genres (article/essay/news/marketing/book) at any length, → false.
- Always pick a passthroughType when isPassthrough is true: install-instructions for setup choreography, skill-definition for a persona/system prompt. When both fit, prefer skill-definition.`;

  const t0 = performance.now();
  let data: any;
  try {
    data = await openRouterChatCompletion({
      apiKey,
      stage: "classifier",
      body: {
        model: getClassifierModel(),
        messages: [{ role: "user", content: classifierPrompt }],
        temperature: 0.2,
      },
      signal: externalSignal,
      timeoutMs: OPENROUTER_TIMEOUT_MS,
      trace,
    });
  } catch (err) {
    if (isExpectedHelperFailure(err)) {
      console.error(
        "[templateGen] Content classifier failed:",
        describeLlmError(err),
      );
      return null;
    }
    throw err;
  }

  console.log(
    `[templateGen] classifyContent ok: model=${data?.model}, latencyMs=${Math.round(performance.now() - t0)}, prompt=${data?.usage?.prompt_tokens}, completion=${data?.usage?.completion_tokens}`,
  );
  const tokens: PassthroughTokens = {
    promptTokens: Number(data?.usage?.prompt_tokens ?? 0),
    completionTokens: Number(data?.usage?.completion_tokens ?? 0),
  };
  const content_response = data?.choices?.[0]?.message?.content;
  if (!content_response) return null;

  const cleaned = content_response
    .replace(/^```json?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  const match = content_response.match(/\{[\s\S]*"isPassthrough"[\s\S]*\}/);
  const classification =
    parseClassifierResult(cleaned) ??
    (match ? parseClassifierResult(match[0]) : null);
  if (!classification) {
    console.error(
      "[templateGen] Failed to parse/validate classifier response:",
      content_response.slice(0, 300),
    );
    return null;
  }
  return { classification, tokens };
}

/**
 * For pasted text content, detect if it IS agent install instructions or a
 * skill definition, and if so return a ready-to-use template using the content
 * verbatim as the prompt. Returns null if the content is source material —
 * caller should fall back to normal content-based generation.
 */
async function tryContentPassthrough(
  content: string,
  externalSignal?: AbortSignal,
  trace?: TraceContext,
): Promise<PassthroughBundle | null> {
  // Short content normally isn't a prompt — but a short YAML-frontmatter /
  // distinctive-header skill-definition still is, and the deterministic gate in
  // classifyPastedContent should get to fast-path it. Only bail on length when
  // there's no structural signal, so a 40-char "---\nname: Bot\n---\n…" still passes.
  if (
    content.length < PASSTHROUGH_MIN_LENGTH &&
    !detectStructuredSkillDefinition(content)
  ) {
    return null;
  }

  const classifierResult = await classifyPastedContent(
    content,
    externalSignal,
    trace,
  );
  if (!classifierResult) return null;
  const { classification, tokens: classifierTokens } = classifierResult;
  if (!classification.isPassthrough || !classification.passthroughType) {
    return null;
  }

  const template = wrapAsPassthroughTemplate(
    content,
    {
      agentName: classification.agentName || "Agent",
      description: classification.description || "A Convos agent.",
      category: classification.category || "Work",
      emoji: classification.emoji || "🤖",
    },
    classification.passthroughType,
  );

  return { template, model: getClassifierModel(), tokens: classifierTokens };
}

/** Extract content via the configured upstream services. Twitter URLs go
 *  through oEmbed; everything else goes through Exa. We deliberately do not
 *  fall back to a direct fetch of the user-supplied URL — that's an SSRF
 *  surface, and the rest of the codebase only fetches env-configured or
 *  hardcoded hosts. If both upstream paths fail, we surface the error rather
 *  than fetching the URL ourselves. */
async function extractUrl(url: string, trace?: TraceContext): Promise<string> {
  if (isTwitterUrl(url)) {
    try {
      return await extractViaTweetOEmbed(url, trace);
    } catch (err: any) {
      console.error(
        "[templateGen] Tweet oEmbed failed, trying Exa:",
        err.message,
      );
    }
  }

  return await extractViaExa(url, trace);
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

/**
 * Generate a template definition from any input type — short idea, long content,
 * URL (extracted via Exa/oEmbed), PDF (native OpenRouter), or image (vision).
 */
export async function generateTemplate(
  input: GenerateTemplateInput | string,
  externalSignal?: AbortSignal,
  prefill?: GenerationPrefill | null,
  trace?: TraceContext,
  systemPromptOverride?: string | null,
): Promise<GenerationResult> {
  // Backward compat: string input = text
  const opts: GenerateTemplateInput =
    typeof input === "string" ? { text: input } : input;

  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error("BUILDER_OPENROUTER_API_KEY not configured");
  }
  // A per-request override (the admin tool's custom builder prompt) wins over
  // the file/test-seam prompt; an empty/whitespace value falls through to the
  // canonical prompt. The override replaces the canonical prompt's field-quality
  // guidance, so append BUILDER_CONTRACT_RAIL to re-assert it (the response
  // schema still enforces the JSON shape either way).
  const trimmedOverride = systemPromptOverride?.trim();
  const systemPrompt = trimmedOverride
    ? `${trimmedOverride}\n\n---\n\n${BUILDER_CONTRACT_RAIL}`
    : getSystemPrompt();
  if (!systemPrompt) {
    throw new Error("Template generator system prompt not loaded");
  }

  // Overall timing for all paths (including passthrough)
  const funcStart = performance.now();

  // For file paths (image / pdf), the user's typed text is a directive
  // about how to USE the material. Empty when only a file is attached.
  const intentText = (opts.text || "").trim();
  const intentNote = intentText ? `\n\nUser's intent: ${intentText}` : "";

  let userContent: any;
  const model = getModel();

  if (opts.imageBase64) {
    // Image path: send as image_url for vision models
    const mime = opts.mimeType || "image/png";
    userContent = [
      {
        type: "text",
        text: `Create an assistant based on what you see in this image. Infer the topic, purpose, and audience from the visual content.${intentNote}`,
      },
      {
        type: "image_url",
        image_url: { url: `data:${mime};base64,${opts.imageBase64}` },
      },
    ];
  } else if (opts.pdfBase64) {
    // PDF path: native support via OpenRouter
    const filename = opts.filename || "document.pdf";
    userContent = [
      {
        type: "text",
        text: `Create an assistant based on the content of this PDF document.${intentNote}`,
      },
      {
        type: "file",
        file: {
          filename,
          file_data: `data:application/pdf;base64,${opts.pdfBase64}`,
        },
      },
    ];
  } else {
    // Text path: idea, content, or URL
    let extracted = intentText;

    if (intentText && looksLikeUrl(intentText)) {
      const url = intentText.trim();
      try {
        new URL(url);
      } catch {
        throw new AppError(400, "Invalid URL");
      }

      // For GitHub URLs, try to short-circuit:
      //  - `passthrough`: the repo/file IS an agent prompt → return verbatim.
      //  - `rawContent`: the user linked a specific file but it's not
      //    agent-ready → use the fetched file content as source material
      //    (skip extractUrl, which would scrape GitHub's HTML viewer).
      const githubResult = await tryGithubPassthrough(
        url,
        externalSignal,
        trace,
      );
      if (githubResult?.kind === "passthrough") {
        const { bundle } = githubResult;
        return {
          template: bundle.template,
          metrics: {
            model: bundle.model,
            promptTokens: bundle.tokens.promptTokens,
            completionTokens: bundle.tokens.completionTokens,
            latencyMs: Math.round(performance.now() - funcStart),
          },
        };
      }

      extracted =
        githubResult?.kind === "rawContent"
          ? githubResult.content
          : await extractUrl(url, trace);
    }

    if (!extracted.trim()) {
      throw new AppError(400, "No content extracted");
    }

    // Before running full generation, classify the extracted text — if it's
    // already an agent install guide or skill definition, use it verbatim.
    const passthroughBundle = await tryContentPassthrough(
      extracted,
      externalSignal,
      trace,
    );
    if (passthroughBundle)
      return {
        template: passthroughBundle.template,
        metrics: {
          model: passthroughBundle.model,
          promptTokens: passthroughBundle.tokens.promptTokens,
          completionTokens: passthroughBundle.tokens.completionTokens,
          latencyMs: Math.round(performance.now() - funcStart),
        },
      };

    if (extracted.length > MAX_CONTENT_LENGTH) {
      extracted = extracted.slice(0, MAX_CONTENT_LENGTH);
    }

    userContent = `Create an assistant based on the following content:\n\n---\n${extracted}\n---`;
  }

  // Caller-pinned identity: fold the already-chosen name/emoji into the user
  // message so the model writes agentName, the prompt body, all self-references,
  // and the WELCOME MESSAGE as this named assistant. Without this the model
  // invents its own identity and the persist-stage applyPrefill overlay leaves
  // the card's name at odds with the prompt the assistant actually runs on.
  const identityDirective = buildIdentityDirective(prefill);
  if (identityDirective) {
    if (typeof userContent === "string") {
      userContent = `${userContent}${identityDirective}`;
    } else if (
      Array.isArray(userContent) &&
      userContent[0]?.type === "text" &&
      typeof userContent[0].text === "string"
    ) {
      userContent[0].text = `${userContent[0].text}${identityDirective}`;
    }
  }

  const reqBody: any = {
    model,
    messages: [
      // Prompt-caching breakpoint on the static ~12k-token system prompt. It's
      // byte-identical across every generation, so caching its prefix cuts
      // input cost ~90% on cache hits and trims prefill latency. Uses a
      // PER-BLOCK `cache_control` breakpoint (not top-level) so the Bedrock
      // provider preference still applies — top-level cache_control forces
      // Anthropic-only routing on OpenRouter. The varying user message after
      // the breakpoint is re-processed each call. Cache usage is observable via
      // `$ai_cache_read_input_tokens` / `$ai_cache_creation_input_tokens`.
      //
      // 1-hour TTL (vs the 5-min default): builder traffic is bursty, so the
      // default would expire between generations and re-write (no read benefit).
      // The only cost of 1h is a higher write multiplier on misses (2x input vs
      // 1.25x); reads are 0.1x either way. Net cheaper + faster whenever two
      // generations land within an hour. Supported per-block on Bedrock.
      //
      // `systemPrompt` (not the raw SYSTEM_PROMPT import) so both the eval
      // harness's __setSystemPromptOverrideForTests seam AND a per-request
      // `systemPromptOverride` (the admin preview tool) still apply. In
      // production neither is set, so the text stays byte-identical and
      // caches; a preview override is intentionally a cache miss (low volume,
      // dev/admin-only).
      {
        role: "system",
        content: [
          {
            type: "text",
            text: systemPrompt,
            cache_control: { type: "ephemeral", ttl: "1h" },
          },
        ],
      },
      { role: "user", content: userContent },
    ],
    temperature: 0.7,
    // Force strict JSON output matching the GeneratedTemplate shape. The system
    // prompt is rich with inner quotes (dialogue examples, markdown, quoted
    // phrases) so at temp 0.7 the model occasionally emits an unescaped `"`
    // mid-string and breaks JSON.parse. json_schema mode is OpenRouter's
    // first-class structured-output feature and enforces both shape and
    // valid JSON at the provider level.
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "generated_template",
        strict: true,
        schema: {
          type: "object",
          properties: {
            prompt: { type: "string" },
            agentName: { type: "string" },
            emoji: { type: "string" },
            description: { type: "string" },
            category: { type: "string", enum: [...TEMPLATE_CATEGORIES] },
            tools: {
              type: "array",
              items: { type: "string", enum: [...TEMPLATE_TOOLS] },
            },
          },
          required: [
            "prompt",
            "agentName",
            "emoji",
            "description",
            "category",
            "tools",
          ],
          additionalProperties: false,
        },
      },
    },
  };

  const t0 = performance.now();
  let data: any;
  try {
    data = await openRouterChatCompletion({
      apiKey,
      stage: "generate",
      body: reqBody,
      signal: externalSignal,
      timeoutMs: OPENROUTER_TIMEOUT_MS,
      trace,
    });
  } catch (err) {
    if (isTimeoutOrAbort(err)) {
      throw new AppError(
        504,
        `OpenRouter request timed out after ${OPENROUTER_TIMEOUT_MS}ms`,
      );
    }
    if (isHttpStatusError(err)) {
      console.error(
        "[templateGen] OpenRouter error:",
        err.status,
        err.message.slice(0, 500),
      );
      throw new Error(`OpenRouter API error ${err.status}`);
    }
    throw err;
  }
  const latencyMs = Math.round(performance.now() - t0);
  const promptTokens = Number(data?.usage?.prompt_tokens ?? 0);
  const completionTokens = Number(data?.usage?.completion_tokens ?? 0);
  const responseModel = String(data?.model ?? model);
  console.log(
    `[templateGen] generate ok: model=${responseModel}, latencyMs=${latencyMs}, prompt=${promptTokens}, completion=${completionTokens}`,
  );

  if (data?.error) {
    throw new Error(`LLM error: ${data.error.message || "unknown"}`);
  }

  const content = data?.choices?.[0]?.message?.content;
  if (!content) {
    console.error(
      "[templateGen] Empty LLM response:",
      JSON.stringify(data).slice(0, 500),
    );
    throw new Error("No content in LLM response");
  }

  const parsed = parseTemplateResponse(content);
  // Server-injects connections: [] on every successful return
  const withConnections = { ...parsed, connections: [] as string[] };
  const finalTemplate = appendBrevityRail(withConnections);
  return {
    template: finalTemplate,
    metrics: {
      model: responseModel,
      promptTokens,
      completionTokens,
      latencyMs,
    },
  };
}

/** Parse and validate LLM response into a GeneratedTemplate. Exported for testing. */
export function parseTemplateResponse(
  content: string,
): Omit<GeneratedTemplate, "connections"> {
  let parsed: any;
  try {
    const cleaned = content
      .replace(/^```json?\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();
    parsed = JSON.parse(cleaned);
  } catch {
    // Fallback: extract JSON block containing agentName
    const match = content.match(/\{[\s\S]*"agentName"[\s\S]*\}/);
    if (!match) {
      throw new Error(
        `Failed to parse LLM response as JSON: ${content.slice(0, 200)}`,
      );
    }
    try {
      parsed = JSON.parse(match[0]);
    } catch {
      throw new Error(
        `Failed to parse extracted JSON: ${match[0].slice(0, 200)}`,
      );
    }
  }

  if (
    !parsed.agentName ||
    typeof parsed.agentName !== "string" ||
    parsed.agentName.trim() === ""
  ) {
    throw new Error("LLM response missing agentName");
  }

  // `prompt` is a required column on AgentTemplate. Persisting an empty
  // prompt would create a semantically-broken template (no instructions
  // for the agent), so reject the LLM response here rather than swallow
  // it with `parsed.prompt || ""`. Mirrors the agentName check above.
  if (
    !parsed.prompt ||
    typeof parsed.prompt !== "string" ||
    parsed.prompt.trim() === ""
  ) {
    throw new Error("LLM response missing prompt");
  }

  return {
    agentName: parsed.agentName,
    description: parsed.description || "",
    prompt: parsed.prompt,
    category: parsed.category || "",
    emoji: parsed.emoji || "",
    tools: Array.isArray(parsed.tools) ? parsed.tools : [],
  };
}

// ---------------------------------------------------------------------------
// Test seam — allows tests to override generateTemplate at the singleton seam
// (mirrors the __resetComposioServiceForTests pattern in connections).
// ---------------------------------------------------------------------------

let _generateTemplateOverride:
  | ((
      input: GenerateTemplateInput | string,
      signal?: AbortSignal,
      prefill?: GenerationPrefill | null,
      trace?: TraceContext,
      systemPromptOverride?: string | null,
    ) => Promise<GenerationResult>)
  | null = null;

/** Install a test override for `generateTemplate`. Pass `null` to restore. */
export function __resetGenerateTemplateForTests(
  override:
    | ((
        input: GenerateTemplateInput | string,
        signal?: AbortSignal,
        prefill?: GenerationPrefill | null,
        trace?: TraceContext,
        systemPromptOverride?: string | null,
      ) => Promise<GenerationResult>)
    | null,
) {
  _generateTemplateOverride = override;
}

/**
 * Dispatch function used by the handler — calls the override if installed,
 * otherwise delegates to the real `generateTemplate`.
 *
 * Optional `signal` aborts the in-flight OpenRouter fetches, so a caller
 * (e.g. the generation executor's per-pipeline timeout) can cancel work
 * mid-LLM-call and avoid paying tokens for a result it would discard.
 *
 * Optional `systemPromptOverride` lets a trusted caller (the admin preview
 * tool) swap the builder system prompt for a single request without
 * persisting anything; omitted on the production generation path.
 */
export async function callGenerateTemplate(
  input: GenerateTemplateInput | string,
  signal?: AbortSignal,
  prefill?: GenerationPrefill | null,
  trace?: TraceContext,
  systemPromptOverride?: string | null,
): Promise<GenerationResult> {
  if (_generateTemplateOverride) {
    return _generateTemplateOverride(
      input,
      signal,
      prefill,
      trace,
      systemPromptOverride,
    );
  }
  return generateTemplate(input, signal, prefill, trace, systemPromptOverride);
}

export { BREVITY_RAIL, BUILDER_CONTRACT_RAIL };
