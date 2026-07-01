/**
 * Integration coverage for the PII redaction gate on the create/patch handlers.
 *
 * The rest of the suite runs with the global no-op redaction stub
 * (tests/setup.ts), so the REAL path — masked values actually persisted, the
 * 502 fail-closed rejection, and PATCH scanning only the changed fields — is
 * never exercised end-to-end. This file opts out of the stub and drives the
 * real `redactTemplatePii` against a mocked OpenRouter client (no live model),
 * hitting the router in-process and asserting the persisted row.
 */

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */

import type { Server } from "node:http";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import {
  __resetPiiRedactionForTests,
  __setBuilderApiKeyOverrideForTests,
  __setPiiModelOverrideForTests,
} from "@/api/v2/agent-templates/services/moderation";
import { openRouterChatCompletion } from "@/api/v2/agent-templates/services/openrouter-client";
import { ADMIN_ACCOUNT_ID } from "@/utils/constants";
import { createJwtToken } from "@/utils/jwt";
import { prisma } from "@/utils/prisma";
import { buildAgentTemplatesApp } from "./agent-templates.cross.helpers";

// Preserve every real export (this test loads the whole router, which pulls in
// modules needing the client's other exports) and override only the chat call.
vi.mock(
  "@/api/v2/agent-templates/services/openrouter-client",
  async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return { ...actual, openRouterChatCompletion: vi.fn() };
  },
);
const mockCall = vi.mocked(openRouterChatCompletion);

/** A chat-completion stub whose message content is the findings JSON. */
function completion(findings: unknown[]): any {
  return { choices: [{ message: { content: JSON.stringify({ findings }) } }] };
}

const app = buildAgentTemplatesApp();
let server: Server;
const baseURL = "http://localhost:4058";

const authHeaders = async () => ({
  "Content-Type": "application/json",
  "X-Convos-AuthToken": await createJwtToken({
    deviceId: "test-device-pii-redaction-int",
    accountId: ADMIN_ACCOUNT_ID,
  }),
});

const cleanup = () =>
  prisma.agentTemplate.deleteMany({
    where: {
      ownerAccountId: ADMIN_ACCOUNT_ID,
      OR: [
        { slug: { startsWith: "pii-int-" } },
        { agentName: { startsWith: "Pii Int" } },
      ],
    },
  });

describe("Agent template PII redaction (integration)", () => {
  beforeAll(async () => {
    await new Promise<void>((resolve) => {
      server = app.listen(4058, () => {
        resolve();
      });
    });
  });

  afterAll(async () => {
    await cleanup();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  });

  beforeEach(async () => {
    await cleanup();
    // Opt out of the global no-op (tests/setup.ts) so the real redactTemplatePii
    // runs against the mocked client.
    __resetPiiRedactionForTests(null);
    __setBuilderApiKeyOverrideForTests("test-key");
    __setPiiModelOverrideForTests("test-model");
    mockCall.mockReset();
  });

  afterEach(() => {
    __setBuilderApiKeyOverrideForTests(undefined);
    __setPiiModelOverrideForTests(null);
  });

  test("create persists masked values (model name + deterministic email)", async () => {
    // Model finds only the person name; the email is caught by the
    // deterministic floor even though the model missed it.
    mockCall.mockResolvedValue(
      completion([
        { field: "description", text: "Maria Gonzalez", type: "person" },
      ]),
    );

    const res = await fetch(`${baseURL}/api/v2/agent-templates`, {
      method: "POST",
      headers: await authHeaders(),
      body: JSON.stringify({
        agentName: "Pii Int Recipe Helper",
        slug: "pii-int-create",
        description: "Built by Maria Gonzalez",
        prompt: "Email me at chef@example.com for recipes",
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;

    const row = await prisma.agentTemplate.findUniqueOrThrow({
      where: { id: body.id as string },
    });
    expect(row.description).toBe("Built by [PERSON]");
    expect(row.prompt).toBe("Email me at [EMAIL] for recipes");
    // agentName is never scanned — it seeds the slug — so it survives verbatim.
    expect(row.agentName).toBe("Pii Int Recipe Helper");
  });

  test("create fails closed (502, nothing persisted) when the scan errors", async () => {
    mockCall.mockRejectedValue(new Error("scan boom"));

    const res = await fetch(`${baseURL}/api/v2/agent-templates`, {
      method: "POST",
      headers: await authHeaders(),
      body: JSON.stringify({
        agentName: "Pii Int Fail Closed",
        slug: "pii-int-fail-closed",
        prompt: "Reach me at 415-555-2671",
      }),
    });
    expect(res.status).toBe(502);

    const count = await prisma.agentTemplate.count({
      where: { ownerAccountId: ADMIN_ACCOUNT_ID, slug: "pii-int-fail-closed" },
    });
    expect(count).toBe(0);
  });

  test("patch scans only the changed field and persists it masked", async () => {
    // Seed a clean row through the handler (model returns no findings).
    mockCall.mockResolvedValue(completion([]));
    const createRes = await fetch(`${baseURL}/api/v2/agent-templates`, {
      method: "POST",
      headers: await authHeaders(),
      body: JSON.stringify({
        agentName: "Pii Int Patch Target",
        slug: "pii-int-patch",
        description: "A clean description with no personal data",
        prompt: "A clean prompt",
      }),
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as any;

    // PATCH only the prompt, with PII in it.
    mockCall.mockClear();
    mockCall.mockResolvedValue(
      completion([{ field: "prompt", text: "Dr. Alice Wren", type: "person" }]),
    );
    const patchRes = await fetch(
      `${baseURL}/api/v2/agent-templates/${created.id}`,
      {
        method: "PATCH",
        headers: await authHeaders(),
        body: JSON.stringify({
          prompt: "Escalate to Dr. Alice Wren at alice.wren@clinic.org",
        }),
      },
    );
    expect(patchRes.status).toBe(200);

    const row = await prisma.agentTemplate.findUniqueOrThrow({
      where: { id: created.id as string },
    });
    // Name (model) + email (deterministic) both masked.
    expect(row.prompt).toBe("Escalate to [PERSON] at [EMAIL]");
    // Untouched field is unchanged.
    expect(row.description).toBe("A clean description with no personal data");

    // The scan for this PATCH saw ONLY the changed field: the prompt built for
    // the model contains the new prompt text but not the untouched description.
    const scanned = mockCall.mock.calls[0]?.[0]?.body?.messages?.[0]
      ?.content as string;
    expect(scanned).toContain("Escalate to Dr. Alice Wren");
    expect(scanned).not.toContain("A clean description with no personal data");
  });
});
