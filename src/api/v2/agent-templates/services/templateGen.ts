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
 * Helper calls (GitHub-instructions selector, content-classifier) at temp 0.2
 * without response_format.
 *
 * Soft defaults for non-name fields. Server-injects connections: [].
 */

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument */

import {
  BUILDER_MODEL,
  BUILDER_OPENROUTER_API_KEY,
  EXA_SERVICE_KEY,
} from "@/config";
import { AppError } from "@/utils/errors";
import { SYSTEM_PROMPT } from "../lib/system-prompt";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_CONTENT_LENGTH = 10_000;
const DEFAULT_MODEL = "@preset/assistants-pro";

// Wallclock cap for every OpenRouter call (selector, classifier, main).
// Today both JSON and SSE handler modes share a single buffered completion,
// so the same wallclock cap covers both. If the runtime ever streams chunks
// from upstream, that path needs a separate per-chunk inactivity timer.
const OPENROUTER_TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------------------
// Config-backed accessors (with test-only override seams)
// ---------------------------------------------------------------------------

let _apiKeyOverride: string | null | undefined = undefined;
let _builderModelOverride: string | null = null;
let _exaKeyOverride: string | null | undefined = undefined;

function getApiKey(): string | null {
  if (_apiKeyOverride !== undefined) return _apiKeyOverride;
  return BUILDER_OPENROUTER_API_KEY || null;
}

function getExaKey(): string | null {
  if (_exaKeyOverride !== undefined) return _exaKeyOverride;
  return EXA_SERVICE_KEY || null;
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

/** Override `EXA_SERVICE_KEY` for tests. Pass `null` to simulate "unset",
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
  model: "@preset/assistants-pro",
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
async function extractViaExa(url: string): Promise<string> {
  const exaKey = getExaKey();
  if (!exaKey) {
    throw new Error("EXA_SERVICE_KEY not configured");
  }

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
  return result.text;
}

/** Extract tweet content via oEmbed, following any embedded links. */
async function extractViaTweetOEmbed(url: string): Promise<string> {
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
      const pageContent = await extractViaExa(tco);
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

async function githubApiGet(path: string): Promise<any> {
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
}

/** Fetch the raw content of a file in a repo at its default branch. */
async function githubFetchRaw(
  owner: string,
  repo: string,
  branch: string,
  path: string,
): Promise<string> {
  const url = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Failed to fetch ${url} (${res.status})`);
  return res.text();
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
- category: one of: Sports & Rec, Travel & Adventures, Food & Dining, Events & Occasions, Hobbies & Interests, Entertainment & Culture, Music & Creative, Kids & Family, Wellness & Fitness, Money & Investing, Work, Local, Superpowers

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
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, OPENROUTER_TIMEOUT_MS);
  // Compose the per-request timeout signal with any external cancellation
  // signal so the fetch aborts whichever fires first.
  const signal = externalSignal
    ? AbortSignal.any([externalSignal, controller.signal])
    : controller.signal;
  let data: any;
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: getModel(),
        messages: [{ role: "user", content: selectorPrompt }],
        temperature: 0.2,
      }),
      signal,
    });

    if (!res.ok) {
      const body = await res.text();
      console.error(
        "[templateGen] GitHub selector LLM error:",
        res.status,
        body.slice(0, 300),
      );
      return null;
    }

    data = (await res.json()) as any;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      console.error(
        `[templateGen] GitHub selector LLM timed out after ${OPENROUTER_TIMEOUT_MS}ms`,
      );
      return null;
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
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
      content = await githubFetchRaw(owner, repo, branch, filePath);
    } catch (err: any) {
      console.error(
        `[templateGen] Failed to fetch ${owner}/${repo}/${filePath}:`,
        err.message,
      );
      return null;
    }
    const bundle = await tryContentPassthrough(content, externalSignal);
    if (bundle) return { kind: "passthrough", bundle };
    // Classifier said this isn't agent-ready, but the user linked directly
    // at the file — hand the raw content back to the caller so it can be
    // used as source material. Without this, generateTemplate would fall
    // through to extractUrl(blobUrl), which scrapes the GitHub HTML viewer.
    return { kind: "rawContent", content };
  }

  let repoInfo: any;
  try {
    repoInfo = await githubApiGet(`/repos/${owner}/${repo}`);
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
      githubApiGet(`/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`),
      githubFetchRaw(owner, repo, branch, "README.md").catch(() => ""),
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
    bundle: { template, tokens: selectorTokens },
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

/** Classify pasted content: is it agent-ready, or source material to generate from? */
async function classifyPastedContent(
  content: string,
  externalSignal?: AbortSignal,
): Promise<{
  classification: ContentPassthroughResult;
  tokens: PassthroughTokens;
} | null> {
  const apiKey = getApiKey();
  if (!apiKey) return null;

  const truncated = content.slice(0, 8_000);

  const classifierPrompt = `You are classifying pasted text to decide if it should be used VERBATIM as the prompt for a new AI agent, or treated as source material to design an agent from.

Pasted content:
---
${truncated}
---

Two kinds of content count as "passthrough" (use verbatim, do not re-generate):

Type A — install-instructions: setup choreography addressed to an AI agent
- Second-person language: "Read this, then follow the steps", "Ask the user for API keys"
- Setup commands: git clone, npm install, bun install, export env vars
- Agent workflow: clone → install → configure → adopt skills → report progress
- Clearly addressed to an AI, not to a human developer

Type B — skill-definition: a complete system prompt already written for an agent
- Often has YAML frontmatter with name: and description:
- Direct instructions to an AI: "You are...", "You must...", "Your job is to..."
- Section headers like BRAIN/SOUL/HEART, or THE HOOK, or rules/behavior definitions
- A ready-to-use agent definition, not content ABOUT a topic

Anything else is "source material" — an article, essay, README-for-humans, product spec, book excerpt, etc. — and should NOT be passthrough. For those, return false.

If passthrough, also produce metadata:
- agentName: memorable name derived from the content
- emoji: single emoji that fits
- description: 1-2 sentence third-person description
- category: one of: Sports & Rec, Travel & Adventures, Food & Dining, Events & Occasions, Hobbies & Interests, Entertainment & Culture, Music & Creative, Kids & Family, Wellness & Fitness, Money & Investing, Work, Local, Superpowers

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
- When ambiguous, lean toward false. Better to over-generate than over-passthrough.
- The content must be READY-TO-USE as an agent prompt on its own — if it's merely ABOUT agents or references them in passing, that's false.`;

  const t0 = performance.now();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, OPENROUTER_TIMEOUT_MS);
  const signal = externalSignal
    ? AbortSignal.any([externalSignal, controller.signal])
    : controller.signal;
  let data: any;
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: getModel(),
        messages: [{ role: "user", content: classifierPrompt }],
        temperature: 0.2,
      }),
      signal,
    });

    if (!res.ok) {
      const body = await res.text();
      console.error(
        "[templateGen] Content classifier error:",
        res.status,
        body.slice(0, 300),
      );
      return null;
    }

    data = (await res.json()) as any;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      console.error(
        `[templateGen] Content classifier timed out after ${OPENROUTER_TIMEOUT_MS}ms`,
      );
      return null;
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
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

  try {
    const cleaned = content_response
      .replace(/^```json?\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();
    return {
      classification: JSON.parse(cleaned) as ContentPassthroughResult,
      tokens,
    };
  } catch {
    const match = content_response.match(/\{[\s\S]*"isPassthrough"[\s\S]*\}/);
    if (match) {
      try {
        return {
          classification: JSON.parse(match[0]) as ContentPassthroughResult,
          tokens,
        };
      } catch {
        /* fall through */
      }
    }
    console.error(
      "[templateGen] Failed to parse classifier response:",
      content_response.slice(0, 300),
    );
    return null;
  }
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
): Promise<PassthroughBundle | null> {
  if (content.length < PASSTHROUGH_MIN_LENGTH) return null;

  const classifierResult = await classifyPastedContent(content, externalSignal);
  if (!classifierResult) return null;
  const { classification, tokens: classifierTokens } = classifierResult;
  if (!classification.isPassthrough || !classification.passthroughType) {
    return null;
  }

  const template = wrapAsPassthroughTemplate(
    content,
    {
      agentName: classification.agentName || "Assistant",
      description: classification.description || "A Convos assistant.",
      category: classification.category || "Work",
      emoji: classification.emoji || "🤖",
    },
    classification.passthroughType,
  );

  return { template, tokens: classifierTokens };
}

/** Extract content via the configured upstream services. Twitter URLs go
 *  through oEmbed; everything else goes through Exa. We deliberately do not
 *  fall back to a direct fetch of the user-supplied URL — that's an SSRF
 *  surface, and the rest of the codebase only fetches env-configured or
 *  hardcoded hosts. If both upstream paths fail, we surface the error rather
 *  than fetching the URL ourselves. */
async function extractUrl(url: string): Promise<string> {
  if (isTwitterUrl(url)) {
    try {
      return await extractViaTweetOEmbed(url);
    } catch (err: any) {
      console.error(
        "[templateGen] Tweet oEmbed failed, trying Exa:",
        err.message,
      );
    }
  }

  return await extractViaExa(url);
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
): Promise<GenerationResult> {
  // Backward compat: string input = text
  const opts: GenerateTemplateInput =
    typeof input === "string" ? { text: input } : input;

  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error("BUILDER_OPENROUTER_API_KEY not configured");
  }
  if (!SYSTEM_PROMPT) {
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
      const githubResult = await tryGithubPassthrough(url, externalSignal);
      if (githubResult?.kind === "passthrough") {
        const { bundle } = githubResult;
        return {
          template: bundle.template,
          metrics: {
            model: getModel(),
            promptTokens: bundle.tokens.promptTokens,
            completionTokens: bundle.tokens.completionTokens,
            latencyMs: Math.round(performance.now() - funcStart),
          },
        };
      }

      extracted =
        githubResult?.kind === "rawContent"
          ? githubResult.content
          : await extractUrl(url);
    }

    if (!extracted.trim()) {
      throw new AppError(400, "No content extracted");
    }

    // Before running full generation, classify the extracted text — if it's
    // already an agent install guide or skill definition, use it verbatim.
    const passthroughBundle = await tryContentPassthrough(
      extracted,
      externalSignal,
    );
    if (passthroughBundle)
      return {
        template: passthroughBundle.template,
        metrics: {
          model: getModel(),
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

  const reqBody: any = {
    model,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
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
            category: { type: "string" },
            tools: { type: "array", items: { type: "string" } },
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
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, OPENROUTER_TIMEOUT_MS);
  const signal = externalSignal
    ? AbortSignal.any([externalSignal, controller.signal])
    : controller.signal;
  let data: any;
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(reqBody),
      signal,
    });

    if (!res.ok) {
      const body = await res.text();
      console.error(
        "[templateGen] OpenRouter error:",
        res.status,
        body.slice(0, 500),
      );
      throw new Error(`OpenRouter API error ${res.status}`);
    }

    data = (await res.json()) as any;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new AppError(
        504,
        `OpenRouter request timed out after ${OPENROUTER_TIMEOUT_MS}ms`,
      );
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
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
  | ((input: GenerateTemplateInput | string) => Promise<GenerationResult>)
  | null = null;

/** Install a test override for `generateTemplate`. Pass `null` to restore. */
export function __resetGenerateTemplateForTests(
  override:
    | ((input: GenerateTemplateInput | string) => Promise<GenerationResult>)
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
 */
export async function callGenerateTemplate(
  input: GenerateTemplateInput | string,
  signal?: AbortSignal,
): Promise<GenerationResult> {
  if (_generateTemplateOverride) {
    return _generateTemplateOverride(input);
  }
  return generateTemplate(input, signal);
}

export { BREVITY_RAIL };
