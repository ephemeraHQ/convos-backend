/**
 * Tests for the twitter integration on POST /generations and GET /generations/:id.
 *
 * Covers:
 *   - Body shape: twitterContext fields validated (handle regex, numeric tweetId)
 *   - Twitter intent moderation gate → 422 with category=intent when blocked
 *   - Twitter intent moderation gate passes → row persisted with twitterContext
 *   - Generation pipeline runs ComposeReply when twitterContext is present
 *   - GET response includes reply.text on terminal twitter generations
 *   - Non-twitter generations: ComposeReply does NOT run; reply field absent
 *   - composeReply LLM failure → deterministic fallback text still written
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import {
  __resetComposeReplyForTests,
  buildDeterministicFallback,
} from "@/api/v2/agent-templates/services/compose-reply";
import {
  __resetGenerationExecutorForTests,
  __setExecutorTimeoutMsForTests,
} from "@/api/v2/agent-templates/services/generation-executor";
import {
  __resetModerationForTests,
  __resetTwitterIntentForTests,
} from "@/api/v2/agent-templates/services/moderation";
import { __resetPostHogForTests } from "@/api/v2/agent-templates/services/posthog";
import {
  __resetGenerateTemplateForTests,
  DEFAULT_TEST_METRICS,
} from "@/api/v2/agent-templates/services/templateGen";
import { __setAgentAssetsApiKeyOverrideForTests } from "@/middleware/agentAuth";
import { ADMIN_ACCOUNT_ID } from "@/utils/constants";
import { prisma } from "@/utils/prisma";
import {
  stableUuid,
  startAgentTemplatesServer,
  validAgentAssetsApiKey,
} from "./agent-templates.cross.helpers";
import { makeFakeTemplate } from "./agent-templates.generation.helpers";

// S3 is mocked so attachment-bearing submits clear the existence/size check
// (step 12a) without real S3. HeadObject returns a size well under every cap;
// no other S3 op is exercised on the submit path.
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    send(cmd: { constructor: { name: string } }) {
      if (cmd.constructor.name === "HeadObjectCommand") {
        return Promise.resolve({
          ContentLength: 1_000,
          ContentType: "image/png",
        });
      }
      return Promise.resolve({});
    }
  },
  PutObjectCommand: class {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  },
  HeadObjectCommand: class {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  },
  GetObjectCommand: class {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  },
}));

const TEST_PORT = 4078;
const TEST_SOURCE = "generations-twitter-test";

const fakeTemplate = makeFakeTemplate({
  agentName: "Tweet Replier",
  description: "Helps reply to tweets quickly.",
  prompt: "You compose pithy tweet replies",
  category: "Social",
  emoji: "🐦",
});

const baseHeaders = () => ({
  "Content-Type": "application/json",
  "X-Agent-API-Key": validAgentAssetsApiKey,
});

// Tests pass mnemonic labels; `stableUuid` wraps them in a deterministic
// UUIDv5 shape so the handler's UUID-format requirement is satisfied while
// retries against the same label still dedupe.
const withKey = (key: string) => ({
  ...baseHeaders(),
  "Idempotency-Key": stableUuid(key),
});

const twitterBody = (overrides: Record<string, unknown> = {}) => ({
  source: TEST_SOURCE,
  inputs: { text: "Build a SEC filings summarizer" },
  twitterContext: {
    twitterHandle: "@some_user",
    tweetId: "1789432100123456789",
    idea: "Build a SEC filings summarizer",
  },
  ...overrides,
});

let baseURL: string;
let closeServer: () => Promise<void>;

async function cleanup() {
  await prisma.agentTemplateGeneration.deleteMany({
    where: { ownerAccountId: ADMIN_ACCOUNT_ID, source: TEST_SOURCE },
  });
  await prisma.agentTemplate.deleteMany({
    where: {
      ownerAccountId: ADMIN_ACCOUNT_ID,
      agentName: fakeTemplate.agentName,
    },
  });
}

beforeAll(async () => {
  __setAgentAssetsApiKeyOverrideForTests(validAgentAssetsApiKey);
  __resetPostHogForTests(() => {});
  __resetModerationForTests(() => Promise.resolve({ allowed: true }));
  __resetTwitterIntentForTests(() => Promise.resolve({ allowed: true }));
  __resetGenerateTemplateForTests(() =>
    Promise.resolve({
      template: fakeTemplate,
      metrics: DEFAULT_TEST_METRICS,
    }),
  );

  const server = await startAgentTemplatesServer(TEST_PORT);
  baseURL = server.baseURL;
  closeServer = server.close;
});

afterEach(async () => {
  __resetModerationForTests(() => Promise.resolve({ allowed: true }));
  __resetTwitterIntentForTests(() => Promise.resolve({ allowed: true }));
  __resetComposeReplyForTests(null);
  __setExecutorTimeoutMsForTests(null);
  __resetGenerationExecutorForTests(null);
  await cleanup();
});

afterAll(async () => {
  __resetGenerateTemplateForTests(null);
  __resetPostHogForTests(null);
  __resetModerationForTests(null);
  __resetTwitterIntentForTests(null);
  __resetComposeReplyForTests(null);
  await closeServer();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const post = (
  body: unknown,
  opts: { headers?: Record<string, string>; query?: string } = {},
) =>
  fetch(`${baseURL}/api/v2/agent-templates/generations${opts.query ?? ""}`, {
    method: "POST",
    headers: opts.headers ?? withKey(`tw-${Date.now()}-${Math.random()}`),
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /generations — twitterContext validation", () => {
  test("invalid twitterHandle → 400", async () => {
    const body = twitterBody({
      twitterContext: {
        twitterHandle: "not-a-handle-with-dashes",
        tweetId: "123",
      },
    });
    const res = await post(body, { headers: withKey("tw-bad-handle") });
    expect(res.status).toBe(400);
  });

  test("non-numeric tweetId → 400", async () => {
    const body = twitterBody({
      twitterContext: {
        twitterHandle: "@alice",
        tweetId: "not-numeric",
      },
    });
    const res = await post(body, { headers: withKey("tw-bad-tweet") });
    expect(res.status).toBe(400);
  });

  test("missing twitterHandle → 400", async () => {
    const body = twitterBody({
      twitterContext: { tweetId: "123" },
    });
    const res = await post(body, { headers: withKey("tw-missing-handle") });
    expect(res.status).toBe(400);
  });

  test("twitterContext + attachment-only inputs (no text, no idea) → builds", async () => {
    // An attachment is itself a deliberate build request, so a twitter
    // submission carrying one is exempt from the text-required check (step 6a)
    // and the intent classifier (step 14). Intent is forced to reject here to
    // prove it's skipped, not merely passing.
    __resetTwitterIntentForTests(() =>
      Promise.resolve({ allowed: false, reason: "not_agent_request" }),
    );
    __resetGenerationExecutorForTests(() => Promise.resolve());
    const body = {
      source: TEST_SOURCE,
      inputs: {
        attachments: [{ objectKey: "build/photo.png", mimeType: "image/png" }],
      },
      twitterContext: {
        twitterHandle: "@some_user",
        tweetId: "1789432100123456789",
        // no text, no idea — the photo is the request
      },
    };
    const res = await post(body, { headers: withKey("tw-attachment-only") });
    expect(res.status).toBe(202);

    const rows = await prisma.agentTemplateGeneration.findMany({
      where: { source: TEST_SOURCE, ownerAccountId: ADMIN_ACCOUNT_ID },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].twitterContext).toBeTruthy();
  });
});

describe("POST /generations — twitterContext auth gate", () => {
  // twitterContext is privileged: it is published as a reply attributed to a
  // real twitter handle. Only the bot (agent API key) is in a position to
  // verify handle ownership against the tweet author, so the handler rejects
  // the field for anonymous and JWT-only callers. These tests are the safety
  // net for that gate — without it, an anonymous attacker could impersonate
  // any handle.
  test("anonymous caller with twitterContext → 403", async () => {
    const body = twitterBody();
    const anonKey = stableUuid("tw-anon-gate");
    const res = await post(body, {
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": anonKey,
      },
    });
    expect(res.status).toBe(403);
    const errBody = (await res.json()) as { error: string };
    expect(errBody.error.toLowerCase()).toContain("agent api key");

    // No row was persisted.
    const rows = await prisma.agentTemplateGeneration.findMany({
      where: { idempotencyKey: anonKey },
    });
    expect(rows).toHaveLength(0);
  });
});

describe("POST /generations — twitter intent moderation", () => {
  test("intent blocked → 422 with category=intent (row not created)", async () => {
    __resetTwitterIntentForTests(() =>
      Promise.resolve({ allowed: false, reason: "not_agent_request" }),
    );

    const res = await post(twitterBody(), {
      headers: withKey("tw-intent-blocked"),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { reason: string; category: string };
    expect(body.reason).toBe("not_agent_request");
    expect(body.category).toBe("intent");

    const rows = await prisma.agentTemplateGeneration.findMany({
      where: { source: TEST_SOURCE, ownerAccountId: ADMIN_ACCOUNT_ID },
    });
    expect(rows).toHaveLength(0);
  });

  test("content gate blocks before intent gate runs", async () => {
    let intentCalls = 0;
    __resetModerationForTests(() =>
      Promise.resolve({ allowed: false, reason: "blocked" }),
    );
    __resetTwitterIntentForTests(() => {
      intentCalls += 1;
      return Promise.resolve({ allowed: true });
    });

    const res = await post(twitterBody(), {
      headers: withKey("tw-content-blocks"),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { reason: string; category: string };
    expect(body.category).toBe("content");
    expect(intentCalls).toBe(0);
  });

  test("attachment present → intent gate skipped (photo is the request)", async () => {
    // A photo mention whose only text is the photo's own t.co link would be
    // classified not_agent_request, but the attachment makes intent moot — the
    // gate is skipped entirely (not just passed), so the build proceeds.
    let intentCalls = 0;
    __resetTwitterIntentForTests(() => {
      intentCalls += 1;
      return Promise.resolve({ allowed: false, reason: "not_agent_request" });
    });
    __resetGenerationExecutorForTests(() => Promise.resolve());

    const res = await post(
      {
        source: TEST_SOURCE,
        inputs: {
          text: "https://t.co/y8VfTXPY7f",
          attachments: [
            { objectKey: "build/photo.png", mimeType: "image/png" },
          ],
        },
        twitterContext: {
          twitterHandle: "@some_user",
          tweetId: "1789432100123456789",
        },
      },
      { headers: withKey("tw-attachment-skips-intent") },
    );
    expect(res.status).toBe(202);
    expect(intentCalls).toBe(0);
  });

  test("hasArticle → intent gate skipped (article is the request)", async () => {
    // A `@bot` + shared X Article whose seed is the article body carries no
    // "make an agent" words, so the classifier would reject it — but the folded
    // article is a deliberate build request, so the gate is skipped entirely
    // (like an attachment) and the build proceeds.
    let intentCalls = 0;
    __resetTwitterIntentForTests(() => {
      intentCalls += 1;
      return Promise.resolve({ allowed: false, reason: "not_agent_request" });
    });
    __resetGenerationExecutorForTests(() => Promise.resolve());

    const res = await post(
      {
        source: TEST_SOURCE,
        inputs: {
          text: 'Shared article from @author: "How I built an app"\nA long article body with no explicit build request in it.',
        },
        twitterContext: {
          twitterHandle: "@some_user",
          tweetId: "1789432100123456790",
          hasArticle: true,
        },
      },
      { headers: withKey("tw-article-skips-intent") },
    );
    expect(res.status).toBe(202);
    expect(intentCalls).toBe(0);
  });
});

describe("POST /generations — twitter happy path", () => {
  test("wait_ms inline poll → done with reply.text set", async () => {
    const res = await post(twitterBody(), {
      headers: withKey("tw-happy"),
      query: "?wait_ms=10000",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      generationId: string;
      status: string;
      templateId?: string;
      reply?: { text: string };
    };
    expect(body.status).toBe("done");
    expect(typeof body.templateId).toBe("string");
    expect(body.reply).toBeDefined();
    expect(typeof body.reply?.text).toBe("string");
    expect(body.reply?.text.length).toBeGreaterThan(0);
    // Default deterministic fallback should at least include the handle
    expect(body.reply?.text).toContain("@some_user");
    // The reply URL must use the canonical hashed slug (`<base>.<hash5>`),
    // not the bare base slug. Resolver in resolve-id-or-url-slug.ts
    // requires the hash; passing the base would 404. Regression guard for
    // the executor's buildUrlSlug call.
    expect(body.reply?.text).toMatch(/[a-z0-9-]+\.[0-9a-z]{5}/i);

    // Verify the row stores both templateId and reply
    const row = await prisma.agentTemplateGeneration.findUnique({
      where: { id: body.generationId },
    });
    expect(row?.templateId).toBe(body.templateId as string);
    expect(row?.reply).toBe(body.reply?.text as string);
    expect(row?.twitterContext).toMatchObject({
      twitterHandle: "@some_user",
      tweetId: "1789432100123456789",
    });
  });

  test("LLM-composed reply is used when validator accepts it", async () => {
    const llmReply =
      "@some_user Built it! Meet Tweet Replier — try it now https://dev.convos.org/a/tweet-replier.abcde";
    __resetComposeReplyForTests(() => Promise.resolve({ replyText: llmReply }));

    const res = await post(twitterBody(), {
      headers: withKey("tw-llm-reply"),
      query: "?wait_ms=10000",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { reply?: { text: string } };
    expect(body.reply?.text).toBe(llmReply);
  });

  test("prefilled agentName flows into composeReply", async () => {
    // The executor applies the prefill before persisting AND before
    // calling composeReply, so the Twitter reply reflects the pinned
    // identity instead of the LLM's chosen name.
    let capturedAgentName: string | undefined;
    __resetComposeReplyForTests((input) => {
      capturedAgentName = input.agentName;
      return Promise.resolve({ replyText: "@some_user noop https://x.y/z" });
    });

    const res = await post(
      twitterBody({ prefill: { agentName: "Pinned Name" } }),
      {
        headers: withKey("tw-prefill-name"),
        query: "?wait_ms=10000",
      },
    );
    expect(res.status).toBe(200);
    expect(capturedAgentName).toBe("Pinned Name");
  });

  test("composeReply throwing is caught and yields deterministic fallback", async () => {
    __resetComposeReplyForTests(() => Promise.reject(new Error("boom")));

    const res = await post(twitterBody(), {
      headers: withKey("tw-fallback"),
      query: "?wait_ms=10000",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      reply?: { text: string };
    };
    expect(body.status).toBe("done");
    // Fallback always starts with the normalized handle
    expect(body.reply?.text.startsWith("@some_user")).toBe(true);

    // Sanity: the deterministic fallback is what we expect
    const expected = buildDeterministicFallback({
      handle: "@some_user",
      agentName: fakeTemplate.agentName,
      firstSentence: "Helps reply to tweets quickly",
      urlSlug: body.reply!.text.match(/[a-z0-9-]+\.[a-z0-9]+$/i)?.[0] ?? "",
    });
    // Match prefix, since slug is dynamic
    expect(body.reply?.text.startsWith(expected.split(" — ")[0])).toBe(true);
  });
});

describe("POST /generations — twitter idempotency", () => {
  test("same key + same source + same inputs + different twitterContext → 409", async () => {
    // Submit with twitter context A
    const bodyA = twitterBody({
      twitterContext: {
        twitterHandle: "@alice",
        tweetId: "1111111111111111111",
        idea: "Build a SEC filings summarizer",
      },
    });
    const firstRes = await post(bodyA, {
      headers: withKey("tw-idem-cross-tweet"),
      query: "?wait_ms=10000",
    });
    expect([200, 202]).toContain(firstRes.status);

    // Submit with same source + same inputs but a DIFFERENT tweet under the
    // same idempotency key. dedupeBodiesMatch now includes twitterContext,
    // so this must 409 — without the fix, two unrelated tweets that share
    // idea text would cross-link.
    const bodyB = twitterBody({
      twitterContext: {
        twitterHandle: "@bob",
        tweetId: "2222222222222222222",
        idea: "Build a SEC filings summarizer",
      },
    });
    const secondRes = await post(bodyB, {
      headers: withKey("tw-idem-cross-tweet"),
    });
    expect(secondRes.status).toBe(409);
    const errBody = (await secondRes.json()) as { error: string };
    expect(errBody.error.toLowerCase()).toContain("idempotency-key");
  });
});

describe("POST /generations — non-twitter generations do NOT run ComposeReply", () => {
  test("no twitterContext → reply absent in response", async () => {
    let composeCalls = 0;
    __resetComposeReplyForTests(() => {
      composeCalls += 1;
      return Promise.resolve({ replyText: "should not appear" });
    });

    const res = await post(
      {
        source: TEST_SOURCE,
        inputs: { text: "non-twitter input" },
      },
      {
        headers: withKey("non-twitter"),
        query: "?wait_ms=10000",
      },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      templateId?: string;
      reply?: { text: string };
    };
    expect(body.status).toBe("done");
    expect(body.templateId).toBeTruthy();
    expect(body.reply).toBeUndefined();
    expect(composeCalls).toBe(0);
  });
});
