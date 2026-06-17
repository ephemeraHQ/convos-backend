/**
 * Tests for the attachment surface of POST /api/v2/agent-templates/generations:
 * the `inputs.attachments[]` schema + submit-time fail-fast caps (count, type,
 * per-file/aggregate size, unfetchable references) and the happy multi-
 * attachment submit. S3 HeadObject is mocked; the executor is stubbed so the
 * happy path returns 202 without running real generation.
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
import { __resetGenerationExecutorForTests } from "@/api/v2/agent-templates/services/generation-executor";
import { __resetModerationForTests } from "@/api/v2/agent-templates/services/moderation";
import { __resetPostHogForTests } from "@/api/v2/agent-templates/services/posthog";
import { __setAgentAssetsApiKeyOverrideForTests } from "@/middleware/agentAuth";
import { ADMIN_ACCOUNT_ID } from "@/utils/constants";
import { prisma } from "@/utils/prisma";
import {
  stableUuid,
  startAgentTemplatesServer,
  validAgentAssetsApiKey,
} from "./agent-templates.cross.helpers";

// Mocked HeadObject size, overridable per test. Default well under every cap.
let headSize = 1_000;
let headRejects = false;

const mockSend = vi.fn((cmd: { constructor: { name: string } }) => {
  if (cmd.constructor.name === "HeadObjectCommand") {
    if (headRejects) {
      return Promise.reject(
        Object.assign(new Error("NotFound"), {
          name: "NotFound",
          $metadata: { httpStatusCode: 404 },
        }),
      );
    }
    return Promise.resolve({
      ContentLength: headSize,
      ContentType: "image/png",
    });
  }
  return Promise.resolve({});
});

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    send(cmd: unknown) {
      return mockSend(cmd as { constructor: { name: string } });
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

const TEST_PORT = 4080;
const TEST_SOURCE = "generations-attachments-test";

const withKey = (key: string) => ({
  "Content-Type": "application/json",
  "X-Agent-API-Key": validAgentAssetsApiKey,
  "Idempotency-Key": stableUuid(key),
});

let baseURL: string;
let closeServer: () => Promise<void>;

const post = (body: unknown, headers: Record<string, string>) =>
  fetch(`${baseURL}/api/v2/agent-templates/generations`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

async function cleanup() {
  await prisma.agentTemplateGeneration.deleteMany({
    where: { ownerAccountId: ADMIN_ACCOUNT_ID, source: TEST_SOURCE },
  });
}

beforeAll(async () => {
  __setAgentAssetsApiKeyOverrideForTests(validAgentAssetsApiKey);
  __resetPostHogForTests(() => {});
  __resetModerationForTests(() => Promise.resolve({ allowed: true }));
  // Stub the executor so a successful submit doesn't run real generation/S3.
  __resetGenerationExecutorForTests(() => Promise.resolve());
  const server = await startAgentTemplatesServer(TEST_PORT);
  baseURL = server.baseURL;
  closeServer = server.close;
});

afterEach(async () => {
  headSize = 1_000;
  headRejects = false;
  mockSend.mockClear();
  await cleanup();
});

afterAll(async () => {
  __resetModerationForTests(null);
  __resetPostHogForTests(null);
  __resetGenerationExecutorForTests(null);
  __setAgentAssetsApiKeyOverrideForTests(undefined);
  await closeServer();
});

const imageRef = (n: number) => ({
  objectKey: `build/img-${n}.png`,
  mimeType: "image/png",
});

describe("POST /generations — attachments", () => {
  test("text + N attachments under the caps → 202, attachments persisted", async () => {
    const res = await post(
      {
        source: TEST_SOURCE,
        inputs: {
          text: "make an agent from these",
          attachments: [imageRef(1), imageRef(2), imageRef(3)],
        },
      },
      withKey("multi-ok"),
    );
    expect(res.status).toBe(202);
    const body = (await res.json()) as { generationId: string };
    const row = await prisma.agentTemplateGeneration.findUnique({
      where: { id: body.generationId },
    });
    const inputs = row?.inputs as { attachments?: unknown[] };
    expect(inputs.attachments).toHaveLength(3);
    // One HeadObject per attachment at submit time.
    const heads = mockSend.mock.calls.filter(
      (c) => c[0].constructor.name === "HeadObjectCommand",
    );
    expect(heads).toHaveLength(3);
  });

  test("attachment-only (no text) → 202", async () => {
    const res = await post(
      { source: TEST_SOURCE, inputs: { attachments: [imageRef(1)] } },
      withKey("img-only"),
    );
    expect(res.status).toBe(202);
  });

  test("over the count cap (10 > 9) → 400 (schema)", async () => {
    const attachments = Array.from({ length: 10 }, (_, i) => imageRef(i));
    const res = await post(
      { source: TEST_SOURCE, inputs: { attachments } },
      withKey("too-many"),
    );
    expect(res.status).toBe(400);
  });

  test("unsupported attachment type → 400 (before any S3 call)", async () => {
    const res = await post(
      {
        source: TEST_SOURCE,
        inputs: {
          attachments: [{ objectKey: "build/x.gif", mimeType: "image/gif" }],
        },
      },
      withKey("bad-type"),
    );
    expect(res.status).toBe(400);
    expect(mockSend).not.toHaveBeenCalled();
  });

  test("over the per-file size cap → 400", async () => {
    headSize = 30 * 1024 * 1024; // 30 MB, over the 5 MB image cap
    const res = await post(
      { source: TEST_SOURCE, inputs: { attachments: [imageRef(1)] } },
      withKey("too-big"),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error.toLowerCase()).toContain("size limit");
  });

  test("unfetchable reference → 400", async () => {
    headRejects = true;
    const res = await post(
      { source: TEST_SOURCE, inputs: { attachments: [imageRef(1)] } },
      withKey("missing-obj"),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error.toLowerCase()).toContain("not found");
  });
});
