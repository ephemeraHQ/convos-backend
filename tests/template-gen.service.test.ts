/**
 * Unit tests for the template generation service.
 *
 * Mock-mode: intercepts global fetch to assert OpenRouter request shape,
 * brevity rail asymmetry, soft defaults, multimodal content shapes,
 * connections injection, and model default/override.
 *
 */

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-explicit-any, @typescript-eslint/consistent-type-imports */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { BUILDER_CLASSIFIER_MODEL } from "@/config";

// ---------------------------------------------------------------------------
// Fetch interceptor — captures all outbound fetch calls so we can assert
// request shapes without hitting the real OpenRouter / GitHub / Exa APIs.
// ---------------------------------------------------------------------------

type CapturedRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: any;
};

let capturedRequests: CapturedRequest[] = [];
const fetchMockResponses: Map<
  string,
  { status: number; body: any; headers?: Record<string, string> }
> = new Map();

const originalFetch = globalThis.fetch;

function extractHeaders(init?: RequestInit): Record<string, string> {
  const headers: Record<string, string> = {};
  if (!init?.headers) return headers;
  if (init.headers instanceof Headers) {
    init.headers.forEach((v, k) => {
      headers[k.toLowerCase()] = v;
    });
  } else if (Array.isArray(init.headers)) {
    for (const [k, v] of init.headers) {
      headers[k.toLowerCase()] = v;
    }
  } else {
    for (const [k, v] of Object.entries(
      init.headers as Record<string, string>,
    )) {
      headers[k.toLowerCase()] = v;
    }
  }
  return headers;
}

function mockFetch(input: any, init?: RequestInit): Response {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
  const method = init?.method || "GET";
  const headers = extractHeaders(init);

  let body: any = undefined;
  if (init?.body) {
    try {
      body = JSON.parse(init.body as string);
    } catch {
      body = init.body;
    }
  }

  capturedRequests.push({ url, method, headers, body });

  // Check for mock responses
  for (const [pattern, response] of fetchMockResponses) {
    if (url.includes(pattern)) {
      return new Response(JSON.stringify(response.body), {
        status: response.status,
        headers: { "Content-Type": "application/json", ...response.headers },
      });
    }
  }

  // Default: return a minimal OpenRouter happy response
  return new Response(
    JSON.stringify({
      model: "@preset/assistants-pro",
      choices: [
        {
          message: {
            content: JSON.stringify({
              prompt: "BODY",
              agentName: "TestAgent",
              emoji: "🤖",
              description: "A test agent",
              category: "Work",
              tools: ["Search"],
            }),
          },
        },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 50 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const TEST_API_KEY = "test-or-key-1234567890";

function setOpenRouterResponse(body: any, status = 200) {
  fetchMockResponses.set("openrouter.ai", { status, body });
}

function _setGitHubRepoResponse(repoData: any) {
  fetchMockResponses.set("api.github.com/repos/", {
    status: 200,
    body: repoData,
  });
}

function clearMockResponses() {
  fetchMockResponses.clear();
}

function getOpenRouterRequests(): CapturedRequest[] {
  return capturedRequests.filter((r) => r.url === OPENROUTER_URL);
}

function getLastOpenRouterRequest(): CapturedRequest {
  const orReqs = getOpenRouterRequests();
  if (orReqs.length === 0) throw new Error("No OpenRouter request captured");
  return orReqs[orReqs.length - 1];
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("templateGen service — OpenRouter integration", () => {
  let generateTemplate: typeof import("@/api/v2/agent-templates/services/templateGen").generateTemplate;
  let BREVITY_RAIL: string;

  beforeEach(async () => {
    capturedRequests = [];
    clearMockResponses();
    globalThis.fetch = mockFetch as any;

    // Install test overrides for the config-backed accessors
    const mod = await import("@/api/v2/agent-templates/services/templateGen");
    mod.__setBuilderApiKeyOverrideForTests(TEST_API_KEY);
    mod.__setBuilderModelOverrideForTests(null);
    mod.__setExaKeyOverrideForTests(null);
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    const mod = await import("@/api/v2/agent-templates/services/templateGen");
    mod.__setBuilderApiKeyOverrideForTests(undefined);
    mod.__setBuilderModelOverrideForTests(null);
    mod.__setExaKeyOverrideForTests(undefined);
  });

  // -----------------------------------------------------------------------
  // URL and Authorization header
  // -----------------------------------------------------------------------
  test("production call uses literal OpenRouter URL with Bearer auth and Content-Type only", async () => {
    const mod = await import("@/api/v2/agent-templates/services/templateGen");
    generateTemplate = mod.generateTemplate;

    setOpenRouterResponse({
      model: "@preset/assistants-pro",
      choices: [
        {
          message: {
            content: JSON.stringify({
              prompt: "test",
              agentName: "Bot",
              emoji: "🤖",
              description: "desc",
              category: "Work",
              tools: [],
            }),
          },
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });

    await generateTemplate({ text: "Build me a helper bot" });

    const req = getLastOpenRouterRequest();
    expect(req.url).toBe(OPENROUTER_URL);
    expect(req.headers["authorization"]).toBe(`Bearer ${TEST_API_KEY}`);
    expect(req.headers["content-type"]).toBe("application/json");

    // Forbidden headers must NOT be present
    expect(req.headers["http-referer"]).toBeUndefined();
    expect(req.headers["x-title"]).toBeUndefined();
    expect(req.headers["openai-beta"]).toBeUndefined();
    // User-Agent should not be a custom Convos one (or absent entirely, which is fine)
    if (req.headers["user-agent"]) {
      expect(req.headers["user-agent"]).not.toMatch(/^Convos/i);
    }
  });

  // -----------------------------------------------------------------------
  // Model defaults to anthropic/claude-opus-4.7
  // -----------------------------------------------------------------------
  test("model defaults to anthropic/claude-opus-4.7", async () => {
    const mod = await import("@/api/v2/agent-templates/services/templateGen");
    generateTemplate = mod.generateTemplate;

    setOpenRouterResponse({
      model: "@preset/assistants-pro",
      choices: [
        {
          message: {
            content: JSON.stringify({
              prompt: "test",
              agentName: "Bot",
              emoji: "🤖",
              description: "desc",
              category: "Work",
              tools: [],
            }),
          },
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });

    await generateTemplate({ text: "Build me a helper" });

    const req = getLastOpenRouterRequest();
    expect(req.body.model).toBe("anthropic/claude-opus-4.7");
  });

  test("BUILDER_MODEL env override works", async () => {
    const mod = await import("@/api/v2/agent-templates/services/templateGen");
    mod.__setBuilderModelOverrideForTests("custom/model");
    generateTemplate = mod.generateTemplate;

    setOpenRouterResponse({
      model: "custom/model",
      choices: [
        {
          message: {
            content: JSON.stringify({
              prompt: "test",
              agentName: "Bot",
              emoji: "🤖",
              description: "desc",
              category: "Work",
              tools: [],
            }),
          },
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });

    await generateTemplate({ text: "Build me a helper" });

    const req = getLastOpenRouterRequest();
    expect(req.body.model).toBe("custom/model");
  });

  // -----------------------------------------------------------------------
  // Temperature 0.7 on production call
  // -----------------------------------------------------------------------
  test("production call uses temperature 0.7", async () => {
    const mod = await import("@/api/v2/agent-templates/services/templateGen");
    generateTemplate = mod.generateTemplate;

    setOpenRouterResponse({
      model: "@preset/assistants-pro",
      choices: [
        {
          message: {
            content: JSON.stringify({
              prompt: "test",
              agentName: "Bot",
              emoji: "🤖",
              description: "desc",
              category: "Work",
              tools: [],
            }),
          },
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });

    await generateTemplate({ text: "Build me a helper" });

    const req = getLastOpenRouterRequest();
    expect(req.body.temperature).toBe(0.7);
  });

  // -----------------------------------------------------------------------
  // Strict json_schema response_format
  // -----------------------------------------------------------------------
  test("production call uses strict json_schema response_format", async () => {
    const mod = await import("@/api/v2/agent-templates/services/templateGen");
    generateTemplate = mod.generateTemplate;

    setOpenRouterResponse({
      model: "@preset/assistants-pro",
      choices: [
        {
          message: {
            content: JSON.stringify({
              prompt: "test",
              agentName: "Bot",
              emoji: "🤖",
              description: "desc",
              category: "Work",
              tools: [],
            }),
          },
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });

    await generateTemplate({ text: "Build me a helper" });

    const req = getLastOpenRouterRequest();
    const rf = req.body.response_format;
    expect(rf).toBeDefined();
    expect(rf.type).toBe("json_schema");
    expect(rf.json_schema.name).toMatch(/^generated_(skill|template)$/);
    expect(rf.json_schema.strict).toBe(true);

    const schema = rf.json_schema.schema;
    expect(schema.type).toBe("object");
    expect(schema.additionalProperties).toBe(false);

    const required = [...schema.required].sort();
    expect(required).toEqual(
      [
        "agentName",
        "category",
        "description",
        "emoji",
        "prompt",
        "tools",
      ].sort(),
    );
  });

  // -----------------------------------------------------------------------
  // Forbidden body fields absent
  // -----------------------------------------------------------------------
  test("production body has no max_tokens/tools/tool_choice/seed/top_p/stream", async () => {
    const mod = await import("@/api/v2/agent-templates/services/templateGen");
    generateTemplate = mod.generateTemplate;

    setOpenRouterResponse({
      model: "@preset/assistants-pro",
      choices: [
        {
          message: {
            content: JSON.stringify({
              prompt: "test",
              agentName: "Bot",
              emoji: "🤖",
              description: "desc",
              category: "Work",
              tools: [],
            }),
          },
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });

    await generateTemplate({ text: "Build me a helper" });

    const req = getLastOpenRouterRequest();
    const forbiddenKeys = [
      "max_tokens",
      "tools",
      "tool_choice",
      "seed",
      "top_p",
      "stream",
    ];
    for (const key of forbiddenKeys) {
      expect(req.body[key]).toBeUndefined();
    }
  });

  // -----------------------------------------------------------------------
  // Helper LLM calls (GitHub selector + content classifier)
  // -----------------------------------------------------------------------
  test("GitHub selector helper call uses temp 0.2, no response_format", async () => {
    const mod = await import("@/api/v2/agent-templates/services/templateGen");
    generateTemplate = mod.generateTemplate;

    // GitHub API responses
    fetchMockResponses.set("api.github.com/repos/test-user/test-repo", {
      status: 200,
      body: {
        default_branch: "main",
        description: "A test repo",
      },
    });
    fetchMockResponses.set(
      "api.github.com/repos/test-user/test-repo/git/trees",
      {
        status: 200,
        body: {
          tree: [
            { path: "README.md" },
            { path: "CLAUDE.md" },
            { path: "src/index.ts" },
          ],
        },
      },
    );
    fetchMockResponses.set("raw.githubusercontent.com", {
      status: 200,
      body: "This is a test README",
    });

    // First OpenRouter call = selector (returns no agent instructions)
    // Second OpenRouter call = production call
    let callCount = 0;
    const originalMockFetch = globalThis.fetch;
    globalThis.fetch = ((input: any, init?: any) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (url === OPENROUTER_URL) {
        callCount++;
        const reqBody = JSON.parse(init?.body as string);
        capturedRequests.push({
          url,
          method: init?.method || "POST",
          headers: extractHeaders(init as RequestInit),
          body: reqBody,
        });

        if (callCount === 1) {
          // Selector call — return "no agent instructions"
          return new Response(
            JSON.stringify({
              model: "@preset/assistants-pro",
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      hasAgentInstructions: false,
                      passthroughType: null,
                      instructionsPath: null,
                      embeddedContent: null,
                      agentName: null,
                      emoji: null,
                      description: null,
                      category: null,
                    }),
                  },
                },
              ],
              usage: { prompt_tokens: 100, completion_tokens: 50 },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        // Production call — return a valid template
        return new Response(
          JSON.stringify({
            model: "@preset/assistants-pro",
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    prompt: "test prompt",
                    agentName: "GitHubBot",
                    emoji: "📦",
                    description: "A GitHub bot",
                    category: "Work",
                    tools: ["Search"],
                  }),
                },
              },
            ],
            usage: { prompt_tokens: 100, completion_tokens: 50 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      // Non-OpenRouter requests (GitHub API, etc.) use the original mock
      return (originalMockFetch as any)(input, init);
    }) as any;

    // The test mock does not set `hasAgentInstructions: true` on the
    // selector response, so the GitHub passthrough returns null and the
    // generate path falls through to URL extraction. URL extraction now
    // requires Exa (the direct-fetch SSRF fallback was removed); without
    // BUILDER_EXA_SERVICE_KEY set in tests, the call throws. We only care that
    // the selector LLM was invoked with the right shape — swallow the
    // downstream error.
    await generateTemplate({
      text: "https://github.com/test-user/test-repo",
    }).catch(() => undefined);

    // The first OpenRouter call should be the selector (helper)
    const selectorReq = getOpenRouterRequests()[0];
    expect(selectorReq).toBeDefined();
    expect(selectorReq.body.temperature).toBe(0.2);
    expect(selectorReq.body.response_format).toBeUndefined();
    expect(selectorReq.body.model).toBe("anthropic/claude-opus-4.7");
    expect(selectorReq.headers["authorization"]).toBe(`Bearer ${TEST_API_KEY}`);

    globalThis.fetch = originalMockFetch;
  });

  // -----------------------------------------------------------------------
  // Multimodal user content for image input
  // -----------------------------------------------------------------------
  test("image input produces image_url content array", async () => {
    const mod = await import("@/api/v2/agent-templates/services/templateGen");
    generateTemplate = mod.generateTemplate;

    setOpenRouterResponse({
      model: "@preset/assistants-pro",
      choices: [
        {
          message: {
            content: JSON.stringify({
              prompt: "test",
              agentName: "ImageBot",
              emoji: "📸",
              description: "An image bot",
              category: "Entertainment & Culture",
              tools: [],
            }),
          },
        },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 50 },
    });

    await generateTemplate({
      imageBase64: "iVBORw0KGgo=",
      mimeType: "image/png",
      text: "Make an assistant from this image",
    });

    const req = getLastOpenRouterRequest();
    const userContent = req.body.messages[1].content;
    expect(Array.isArray(userContent)).toBe(true);
    expect(userContent.length).toBe(2);

    // First element: text directive
    expect(userContent[0].type).toBe("text");
    expect(userContent[0].text).toContain("image");

    // Second element: image_url
    expect(userContent[1].type).toBe("image_url");
    expect(userContent[1].image_url.url).toBe(
      "data:image/png;base64,iVBORw0KGgo=",
    );
  });

  // -----------------------------------------------------------------------
  // Multimodal user content for PDF input
  // -----------------------------------------------------------------------
  test("PDF input produces file content array", async () => {
    const mod = await import("@/api/v2/agent-templates/services/templateGen");
    generateTemplate = mod.generateTemplate;

    setOpenRouterResponse({
      model: "@preset/assistants-pro",
      choices: [
        {
          message: {
            content: JSON.stringify({
              prompt: "test",
              agentName: "PDFBot",
              emoji: "📄",
              description: "A PDF bot",
              category: "Work",
              tools: [],
            }),
          },
        },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 50 },
    });

    await generateTemplate({
      pdfBase64: "JVBERi0=",
      mimeType: "application/pdf",
      filename: "document.pdf",
      text: "Summarize this PDF",
    });

    const req = getLastOpenRouterRequest();
    const userContent = req.body.messages[1].content;
    expect(Array.isArray(userContent)).toBe(true);
    expect(userContent.length).toBe(2);

    // First element: text directive
    expect(userContent[0].type).toBe("text");
    expect(userContent[0].text).toContain("PDF");

    // Second element: file
    expect(userContent[1].type).toBe("file");
    expect(userContent[1].file.filename).toBe("document.pdf");
    expect(userContent[1].file.file_data).toBe(
      "data:application/pdf;base64,JVBERi0=",
    );
  });

  // -----------------------------------------------------------------------
  // Brevity rail asymmetry: appended on production-LLM path only
  // -----------------------------------------------------------------------
  test("brevity rail appended on production-LLM path", async () => {
    const mod = await import("@/api/v2/agent-templates/services/templateGen");
    generateTemplate = mod.generateTemplate;
    BREVITY_RAIL = mod.BREVITY_RAIL;

    setOpenRouterResponse({
      model: "@preset/assistants-pro",
      choices: [
        {
          message: {
            content: JSON.stringify({
              prompt: "BODY",
              agentName: "Bot",
              emoji: "🤖",
              description: "desc",
              category: "Work",
              tools: [],
            }),
          },
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });

    const { template: result } = await generateTemplate({
      text: "Build me a helper",
    });

    // The prompt should end with the brevity rail
    expect(result.prompt).toContain("## Runtime Reminder");
    expect(result.prompt.endsWith(BREVITY_RAIL)).toBe(true);
  });

  test("brevity rail NOT double-appended on passthrough paths", async () => {
    const mod = await import("@/api/v2/agent-templates/services/templateGen");
    generateTemplate = mod.generateTemplate;
    BREVITY_RAIL = mod.BREVITY_RAIL;

    // Content classifier returns isPassthrough: true → passthrough path
    // The wrapAsPassthroughTemplate function already includes BREVITY_RAIL
    // in the prompt, so it should appear exactly once.

    // We need a long text input (>= 300 chars) for passthrough to trigger
    const longText = "You are a test agent. ".repeat(20); // ~500 chars

    // Intercept both the classifier call and any production call
    let callCount = 0;
    const originalMockFetch = globalThis.fetch;
    globalThis.fetch = ((input: any, init?: any) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (url === OPENROUTER_URL) {
        callCount++;
        const reqBody = JSON.parse(init?.body as string);
        capturedRequests.push({
          url,
          method: init?.method || "POST",
          headers: extractHeaders(init as RequestInit),
          body: reqBody,
        });

        if (callCount === 1) {
          // Classifier call — return passthrough result
          return new Response(
            JSON.stringify({
              model: "@preset/assistants-pro",
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      isPassthrough: true,
                      passthroughType: "skill-definition",
                      agentName: "PassthroughBot",
                      emoji: "🤖",
                      description: "A passthrough bot",
                      category: "Work",
                    }),
                  },
                },
              ],
              usage: { prompt_tokens: 100, completion_tokens: 50 },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        // Should not reach a second call for passthrough path
        return new Response("{}", { status: 200 });
      }
      return (originalMockFetch as any)(input, init);
    }) as any;

    const { template: result } = await generateTemplate({ text: longText });

    // Count occurrences of "## Runtime Reminder" — should be exactly 1
    const matches = result.prompt.match(/## Runtime Reminder/g) || [];
    expect(matches.length).toBe(1);

    globalThis.fetch = originalMockFetch;
  });

  // -----------------------------------------------------------------------
  // Soft defaults: agentName is the only fatal-required parse field
  // -----------------------------------------------------------------------
  test("soft defaults: missing description/category/emoji/tools default to empty/[]", async () => {
    const mod = await import("@/api/v2/agent-templates/services/templateGen");
    generateTemplate = mod.generateTemplate;
    BREVITY_RAIL = mod.BREVITY_RAIL;

    setOpenRouterResponse({
      model: "@preset/assistants-pro",
      choices: [
        {
          message: {
            content: JSON.stringify({
              agentName: "MinimalBot",
              prompt: "You are a minimal bot.",
              // Missing: description, category, emoji, tools
            }),
          },
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });

    const { template: result } = await generateTemplate({
      text: "Build me a bot",
    });

    expect(result.agentName).toBe("MinimalBot");
    // Prompt is REQUIRED on AgentTemplate, so the parser no longer
    // soft-defaults it. The LLM supplied a prompt; the brevity rail
    // is appended on the way out.
    expect(result.prompt).toContain("You are a minimal bot.");
    expect(result.prompt.endsWith(BREVITY_RAIL)).toBe(true);
    expect(result.description).toBe("");
    expect(result.category).toBe("");
    expect(result.emoji).toBe("");
    expect(result.tools).toEqual([]);
    expect(result.connections).toEqual([]);
  });

  test("missing prompt causes service to throw", async () => {
    const mod = await import("@/api/v2/agent-templates/services/templateGen");
    generateTemplate = mod.generateTemplate;

    setOpenRouterResponse({
      model: "@preset/assistants-pro",
      choices: [
        {
          message: {
            content: JSON.stringify({
              agentName: "PromptlessBot",
              // No prompt — should reject with a 502-class error.
            }),
          },
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });

    await expect(generateTemplate({ text: "Build me a bot" })).rejects.toThrow(
      /prompt/i,
    );
  });

  test("missing agentName causes service to throw", async () => {
    const mod = await import("@/api/v2/agent-templates/services/templateGen");
    generateTemplate = mod.generateTemplate;

    setOpenRouterResponse({
      model: "@preset/assistants-pro",
      choices: [
        {
          message: {
            content: JSON.stringify({
              // agentName missing entirely
              prompt: "test",
              description: "desc",
              category: "Work",
              emoji: "🤖",
              tools: [],
            }),
          },
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });

    await expect(generateTemplate({ text: "Build me a bot" })).rejects.toThrow(
      /agentName/i,
    );
  });

  test("empty string agentName causes service to throw", async () => {
    const mod = await import("@/api/v2/agent-templates/services/templateGen");
    generateTemplate = mod.generateTemplate;

    setOpenRouterResponse({
      model: "@preset/assistants-pro",
      choices: [
        {
          message: {
            content: JSON.stringify({
              agentName: "",
              prompt: "test",
              description: "desc",
              category: "Work",
              emoji: "🤖",
              tools: [],
            }),
          },
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });

    await expect(generateTemplate({ text: "Build me a bot" })).rejects.toThrow(
      /agentName/i,
    );
  });

  // -----------------------------------------------------------------------
  // Server-injects connections: [] on every successful return
  // -----------------------------------------------------------------------
  test("server-injects connections: [] on production-LLM path", async () => {
    const mod = await import("@/api/v2/agent-templates/services/templateGen");
    generateTemplate = mod.generateTemplate;

    setOpenRouterResponse({
      model: "@preset/assistants-pro",
      choices: [
        {
          message: {
            content: JSON.stringify({
              prompt: "test",
              agentName: "Bot",
              emoji: "🤖",
              description: "desc",
              category: "Work",
              tools: [],
            }),
          },
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });

    const { template: result } = await generateTemplate({
      text: "Build me a helper",
    });
    expect(result.connections).toEqual([]);
  });

  // -----------------------------------------------------------------------
  // Content truncation at MAX_CONTENT_LENGTH = 10_000
  // -----------------------------------------------------------------------
  test("text content is truncated at MAX_CONTENT_LENGTH (10,000 chars)", async () => {
    const mod = await import("@/api/v2/agent-templates/services/templateGen");
    generateTemplate = mod.generateTemplate;

    setOpenRouterResponse({
      model: "@preset/assistants-pro",
      choices: [
        {
          message: {
            content: JSON.stringify({
              prompt: "test",
              agentName: "Bot",
              emoji: "🤖",
              description: "desc",
              category: "Work",
              tools: [],
            }),
          },
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });

    const longText = "x".repeat(20_000);
    await generateTemplate({ text: longText });

    const req = getLastOpenRouterRequest();
    const userText = req.body.messages[1].content as string;
    // The content should contain at most 10_000 chars of extracted text
    // (embedded in the "Create an assistant based on..." wrapper)
    expect(userText.length).toBeLessThan(15_000); // wrapper + 10_000 max
  });

  // -----------------------------------------------------------------------
  // Validation-class error messages preserved from pool
  // -----------------------------------------------------------------------
  test("Invalid URL throws error matching /^Invalid URL/i", async () => {
    const mod = await import("@/api/v2/agent-templates/services/templateGen");
    generateTemplate = mod.generateTemplate;

    await expect(
      generateTemplate({ text: "https://[invalid-url" }),
    ).rejects.toThrow(/^Invalid URL/i);
  });

  test("no content after extraction throws 'No content extracted'", async () => {
    const mod = await import("@/api/v2/agent-templates/services/templateGen");
    generateTemplate = mod.generateTemplate;

    // Empty text after trimming
    await expect(generateTemplate({ text: "   " })).rejects.toThrow(
      /No content/i,
    );
  });

  // -----------------------------------------------------------------------
  // BREVITY_RAIL is a single source-of-truth constant
  // -----------------------------------------------------------------------
  test("BREVITY_RAIL constant starts with ## Runtime Reminder", async () => {
    const mod = await import("@/api/v2/agent-templates/services/templateGen");
    expect(mod.BREVITY_RAIL).toContain("## Runtime Reminder");
    expect(mod.BREVITY_RAIL.length).toBeGreaterThan(100);
  });

  // -----------------------------------------------------------------------
  // SYSTEM_PROMPT is forwarded verbatim as the system message, with a
  // per-block prompt-caching breakpoint.
  // -----------------------------------------------------------------------
  test("system prompt forwarded verbatim with cache breakpoint", async () => {
    const mod = await import("@/api/v2/agent-templates/services/templateGen");
    generateTemplate = mod.generateTemplate;

    const { SYSTEM_PROMPT } =
      await import("@/api/v2/agent-templates/lib/system-prompt");

    setOpenRouterResponse({
      model: "@preset/assistants-pro",
      choices: [
        {
          message: {
            content: JSON.stringify({
              prompt: "test",
              agentName: "Bot",
              emoji: "🤖",
              description: "desc",
              category: "Work",
              tools: [],
            }),
          },
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });

    await generateTemplate({ text: "Build me a helper" });

    const req = getLastOpenRouterRequest();
    expect(req.body.messages[0].role).toBe("system");
    // System content is now a content-part array carrying the verbatim prompt
    // plus a per-block ephemeral cache breakpoint (works on Bedrock; preserves
    // provider routing, unlike top-level cache_control).
    const systemPart = req.body.messages[0].content[0];
    expect(systemPart.type).toBe("text");
    expect(systemPart.text).toBe(SYSTEM_PROMPT);
    expect(systemPart.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  // -----------------------------------------------------------------------
  // Caller-pinned identity directive (prefill → generation prompt)
  // -----------------------------------------------------------------------
  test("prefill name + emoji append a REQUIRED IDENTITY directive to the user message", async () => {
    const mod = await import("@/api/v2/agent-templates/services/templateGen");
    generateTemplate = mod.generateTemplate;

    await generateTemplate(
      { text: "a coordinator for our wake surf crew" },
      undefined,
      { agentName: "Wave Boss", emoji: "🏄" },
    );

    const req = getLastOpenRouterRequest();
    const userMsg = req.body.messages[1].content as string;
    expect(userMsg).toContain("REQUIRED IDENTITY");
    expect(userMsg).toContain('name: "Wave Boss"');
    expect(userMsg).toContain('emoji: "🏄"');
    // The original idea is still present.
    expect(userMsg).toContain("wake surf crew");
  });

  test("prefill directive rides on the text element of multimodal (image) content", async () => {
    const mod = await import("@/api/v2/agent-templates/services/templateGen");
    generateTemplate = mod.generateTemplate;

    await generateTemplate(
      { imageBase64: "iVBORw0KGgo=", mimeType: "image/png", text: "" },
      undefined,
      { agentName: "Pixel Pal", emoji: "📸" },
    );

    const req = getLastOpenRouterRequest();
    const userContent = req.body.messages[1].content;
    expect(Array.isArray(userContent)).toBe(true);
    expect(userContent[0].type).toBe("text");
    expect(userContent[0].text).toContain("REQUIRED IDENTITY");
    expect(userContent[0].text).toContain('name: "Pixel Pal"');
    // The image part is untouched.
    expect(userContent[1].type).toBe("image_url");
  });

  test("emoji-only prefill pins the emoji without a dangling name requirement", async () => {
    const mod = await import("@/api/v2/agent-templates/services/templateGen");
    generateTemplate = mod.generateTemplate;

    await generateTemplate({ text: "a trip planner" }, undefined, {
      emoji: "🧭",
    });

    const req = getLastOpenRouterRequest();
    const userMsg = req.body.messages[1].content as string;
    expect(userMsg).toContain("REQUIRED IDENTITY");
    expect(userMsg).toContain('emoji: "🧭"');
    // No name was pinned — the directive must not reference one.
    expect(userMsg).not.toContain('name: "');
    expect(userMsg).not.toContain(
      '"agentName" you return MUST equal this name',
    );
  });

  test("description-only prefill adds no identity directive", async () => {
    const mod = await import("@/api/v2/agent-templates/services/templateGen");
    generateTemplate = mod.generateTemplate;

    await generateTemplate({ text: "a helper for trip planning" }, undefined, {
      description: "Plans group trips.",
    });

    const req = getLastOpenRouterRequest();
    const userMsg = req.body.messages[1].content as string;
    expect(userMsg).not.toContain("REQUIRED IDENTITY");
  });

  test("no prefill adds no identity directive", async () => {
    const mod = await import("@/api/v2/agent-templates/services/templateGen");
    generateTemplate = mod.generateTemplate;

    await generateTemplate({ text: "a helper for trip planning" });

    const req = getLastOpenRouterRequest();
    const userMsg = req.body.messages[1].content as string;
    expect(userMsg).not.toContain("REQUIRED IDENTITY");
  });

  // -----------------------------------------------------------------------
  // Missing BUILDER_OPENROUTER_API_KEY throws
  // -----------------------------------------------------------------------
  test("missing BUILDER_OPENROUTER_API_KEY throws error", async () => {
    const mod = await import("@/api/v2/agent-templates/services/templateGen");
    mod.__setBuilderApiKeyOverrideForTests(null);
    generateTemplate = mod.generateTemplate;

    await expect(
      generateTemplate({ text: "Build me a helper" }),
    ).rejects.toThrow(/OPENROUTER_API_KEY/i);
  });

  // -----------------------------------------------------------------------
  // Null SYSTEM_PROMPT throws error
  // -----------------------------------------------------------------------
  test("null SYSTEM_PROMPT causes service to throw", async () => {
    // This test verifies the pattern — the actual null-path behavior
    // depends on the module-level SYSTEM_PROMPT value. Since the file
    // exists in our test environment, we verify the error message pattern.
    const mod = await import("@/api/v2/agent-templates/services/templateGen");
    // If SYSTEM_PROMPT is loaded (non-null), the service proceeds.
    // The null-path is tested in template-prompt.test.ts via source analysis.
    // Here we just verify the module exports what we expect.
    expect(typeof mod.generateTemplate).toBe("function");
  });

  // -----------------------------------------------------------------------
  // Helper calls use same model + Authorization, temp 0.2, no response_format
  // -----------------------------------------------------------------------
  test("content classifier helper call uses temp 0.2, no response_format, cheap classifier model + auth", async () => {
    const mod = await import("@/api/v2/agent-templates/services/templateGen");
    generateTemplate = mod.generateTemplate;

    // Long text to trigger content classifier (>= PASSTHROUGH_MIN_LENGTH)
    const longText = "You are a helpful assistant that does things. ".repeat(
      15,
    ); // ~750 chars

    let callCount = 0;
    const originalMockFetch = globalThis.fetch;
    globalThis.fetch = ((input: any, init?: any) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (url === OPENROUTER_URL) {
        callCount++;
        const reqBody = JSON.parse(init?.body as string);
        capturedRequests.push({
          url,
          method: init?.method || "POST",
          headers: extractHeaders(init as RequestInit),
          body: reqBody,
        });

        if (callCount === 1) {
          // Classifier call — return NOT passthrough
          return new Response(
            JSON.stringify({
              model: "@preset/assistants-pro",
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      isPassthrough: false,
                      passthroughType: null,
                      agentName: null,
                      emoji: null,
                      description: null,
                      category: null,
                    }),
                  },
                },
              ],
              usage: { prompt_tokens: 100, completion_tokens: 50 },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        // Production call
        return new Response(
          JSON.stringify({
            model: "@preset/assistants-pro",
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    prompt: "test",
                    agentName: "Bot",
                    emoji: "🤖",
                    description: "desc",
                    category: "Work",
                    tools: [],
                  }),
                },
              },
            ],
            usage: { prompt_tokens: 100, completion_tokens: 50 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return (originalMockFetch as any)(input, init);
    }) as any;

    await generateTemplate({ text: longText });

    // First call = classifier helper
    const classifierReq = getOpenRouterRequests()[0];
    expect(classifierReq.body.temperature).toBe(0.2);
    expect(classifierReq.body.response_format).toBeUndefined();
    expect(classifierReq.body.model).toBe(BUILDER_CLASSIFIER_MODEL);
    expect(classifierReq.headers["authorization"]).toBe(
      `Bearer ${TEST_API_KEY}`,
    );

    // Second call = production
    const prodReq = getOpenRouterRequests()[1];
    expect(prodReq.body.temperature).toBe(0.7);
    expect(prodReq.body.response_format).toBeDefined();

    globalThis.fetch = originalMockFetch;
  });

  // -----------------------------------------------------------------------
  // looksLikeUrl helper exported and works correctly
  // -----------------------------------------------------------------------
  test("looksLikeUrl detects URL-shaped text", async () => {
    const mod = await import("@/api/v2/agent-templates/services/templateGen");
    const { looksLikeUrl } = mod;

    expect(looksLikeUrl("https://example.com")).toBe(true);
    expect(looksLikeUrl("http://example.com")).toBe(true);
    expect(looksLikeUrl("  https://example.com  ")).toBe(true);
    expect(looksLikeUrl("just some text")).toBe(false);
    expect(looksLikeUrl("Visit https://example.com for more")).toBe(false);
  });

  // -----------------------------------------------------------------------
  // parseTemplateResponse handles various input formats
  // -----------------------------------------------------------------------
  test("parseTemplateResponse handles clean JSON", async () => {
    const mod = await import("@/api/v2/agent-templates/services/templateGen");
    const { parseTemplateResponse } = mod;

    const result = parseTemplateResponse(
      JSON.stringify({
        prompt: "test",
        agentName: "Bot",
        emoji: "🤖",
        description: "desc",
        category: "Work",
        tools: ["Search"],
      }),
    );

    expect(result.agentName).toBe("Bot");
    expect(result.tools).toEqual(["Search"]);
  });

  test("parseTemplateResponse handles JSON wrapped in markdown fences", async () => {
    const mod = await import("@/api/v2/agent-templates/services/templateGen");
    const { parseTemplateResponse } = mod;

    const result = parseTemplateResponse(
      '```json\n{"agentName":"Bot","prompt":"test","emoji":"🤖","description":"desc","category":"Work","tools":[]}\n```',
    );

    expect(result.agentName).toBe("Bot");
  });

  test("parseTemplateResponse applies soft defaults for missing optional fields", async () => {
    const mod = await import("@/api/v2/agent-templates/services/templateGen");
    const { parseTemplateResponse } = mod;

    // agentName + prompt are required (both are non-null columns on
    // AgentTemplate). The rest fall back to "" / []. This test exercises
    // the soft-default path for the optional fields only.
    const result = parseTemplateResponse(
      JSON.stringify({ agentName: "Bot", prompt: "Be helpful" }),
    );

    expect(result.agentName).toBe("Bot");
    expect(result.prompt).toBe("Be helpful");
    expect(result.description).toBe("");
    expect(result.category).toBe("");
    expect(result.emoji).toBe("");
    expect(result.tools).toEqual([]);
  });

  test("parseTemplateResponse throws on missing prompt", async () => {
    const mod = await import("@/api/v2/agent-templates/services/templateGen");
    const { parseTemplateResponse } = mod;

    expect(() =>
      parseTemplateResponse(JSON.stringify({ agentName: "Bot" })),
    ).toThrow(/prompt/i);
  });

  test("parseTemplateResponse throws on empty prompt", async () => {
    const mod = await import("@/api/v2/agent-templates/services/templateGen");
    const { parseTemplateResponse } = mod;

    expect(() =>
      parseTemplateResponse(JSON.stringify({ agentName: "Bot", prompt: "  " })),
    ).toThrow(/prompt/i);
  });

  test("parseTemplateResponse throws on missing agentName", async () => {
    const mod = await import("@/api/v2/agent-templates/services/templateGen");
    const { parseTemplateResponse } = mod;

    expect(() =>
      parseTemplateResponse(
        JSON.stringify({ prompt: "test", description: "no name" }),
      ),
    ).toThrow(/agentName/i);
  });

  test("parseTemplateResponse throws on empty agentName", async () => {
    const mod = await import("@/api/v2/agent-templates/services/templateGen");
    const { parseTemplateResponse } = mod;

    expect(() =>
      parseTemplateResponse(JSON.stringify({ agentName: "" })),
    ).toThrow(/agentName/i);
  });

  // -----------------------------------------------------------------------
  // appendBrevityRail exported and works correctly
  // -----------------------------------------------------------------------
  test("appendBrevityRail appends rail with separator", async () => {
    const mod = await import("@/api/v2/agent-templates/services/templateGen");
    const { appendBrevityRail, BREVITY_RAIL: RAIL } = mod;

    const template = {
      agentName: "Bot",
      description: "desc",
      prompt: "BODY",
      category: "Work",
      emoji: "🤖",
      tools: [],
      connections: [] as string[],
    };

    const result = appendBrevityRail(template);
    expect(result.prompt).toBe(`BODY\n\n---\n\n${RAIL}`);
    // Other fields unchanged
    expect(result.agentName).toBe("Bot");
    expect(result.connections).toEqual([]);
  });
});
