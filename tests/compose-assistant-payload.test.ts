import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentTemplate, PublishStatus } from "@prisma/client";
import { describe, expect, test } from "bun:test";
import { composeAssistantPayload } from "@/api/v2/agents/lib/compose-assistant-payload";

// Shared snapshot fixture — mirror of the one PR 1 in convos-assistants
// checks in at
//   runtime/convos-platform/skills/assistant-builder/scripts/handlers/__fixtures__/template-snapshot.json
// The fixture is the *on-disk* `TEMPLATE.json` shape (includes `prompt`).
// The composer's `metadata.template` is the *wire* shape — same fields
// minus `prompt`, which rides separately as `instructions`. The worker
// recombines them at the `/convos/init` boundary so the on-disk view is
// what the runtime reads regardless of which writer (this composer or the
// in-repo skill writer in convos-assistants) produced it. The recombined
// view is what this test asserts against the fixture — that's the drift
// contract between the two repos.
const fixturePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "__fixtures__",
  "template-snapshot.json",
);
const snapshot = JSON.parse(fs.readFileSync(fixturePath, "utf8")) as Record<
  string,
  unknown
>;

// Reconstruct the AgentTemplate Prisma row that — when run through the
// composer — should produce metadata.template equal to the fixture.
const rowFromSnapshot = (
  overrides: Partial<AgentTemplate> = {},
): AgentTemplate => ({
  id: snapshot.id as string,
  slug: snapshot.slug as string,
  // Not on the fixture (intentionally stripped from on-disk shape).
  // Tests can override via the second arg.
  ownerAccountId: "00000000-0000-0000-0000-0000000000aa",
  forkedFromId: snapshot.forkedFromId as string | null,
  agentName: snapshot.agentName as string,
  description: snapshot.description as string | null,
  prompt: snapshot.prompt as string,
  category: snapshot.category as string | null,
  emoji: snapshot.emoji as string | null,
  avatarUrl: snapshot.avatarUrl as string | null,
  tools: snapshot.tools as string[],
  connections: snapshot.connections as string[],
  version: snapshot.version as number,
  firstPublishedAt:
    snapshot.firstPublishedAt === null
      ? null
      : new Date(snapshot.firstPublishedAt as string),
  status: snapshot.status as PublishStatus,
  featured: snapshot.featured as boolean,
  createdAt: new Date(snapshot.createdAt as string),
  updatedAt: new Date(snapshot.createdAt as string),
  ...overrides,
});

describe("composeAssistantPayload", () => {
  test("recombined wire payload reproduces the shared cross-repo on-disk snapshot", () => {
    const composed = composeAssistantPayload({
      template: rowFromSnapshot(),
      joiningUserAccountId: "user-123",
    });

    // Mirror the worker-side recompose at `init-runtime` in PR 2b:
    //   const template = params.metadata?.template
    //     ? { ...params.metadata.template, prompt: params.instructions }
    //     : null;
    // The resulting object is what lands on disk as `TEMPLATE.json` and
    // is what the runtime reads. It must match the fixture byte-for-byte.
    const onDiskShape: Record<string, unknown> = {
      ...(composed.metadata.template as Record<string, unknown>),
      prompt: composed.instructions,
    };
    expect(onDiskShape).toEqual(snapshot);
  });

  test("instructions carries template.prompt verbatim", () => {
    const composed = composeAssistantPayload({
      template: rowFromSnapshot(),
      joiningUserAccountId: "user-123",
    });
    expect(composed.instructions).toBe(snapshot.prompt as string);
  });

  test("top-level name defaults to template.agentName", () => {
    const composed = composeAssistantPayload({
      template: rowFromSnapshot(),
      joiningUserAccountId: "user-123",
    });
    expect(composed.name).toBe(snapshot.agentName as string);
  });

  test("top-level ownerAccountId is the joining user (not the template's owner)", () => {
    const composed = composeAssistantPayload({
      template: rowFromSnapshot({ ownerAccountId: "template-owner-99" }),
      joiningUserAccountId: "user-123",
    });
    expect(composed.ownerAccountId).toBe("user-123");
  });

  test("metadata.template strips template.ownerAccountId entirely", () => {
    const composed = composeAssistantPayload({
      template: rowFromSnapshot({ ownerAccountId: "template-owner-99" }),
      joiningUserAccountId: "user-123",
    });
    const m = composed.metadata.template as Record<string, unknown>;
    expect("ownerAccountId" in m).toBe(false);
  });

  test("metadata.template strips template.prompt entirely (rides on instructions)", () => {
    const composed = composeAssistantPayload({
      template: rowFromSnapshot(),
      joiningUserAccountId: "user-123",
    });
    const m = composed.metadata.template as Record<string, unknown>;
    expect("prompt" in m).toBe(false);
  });

  test("caller name override wins over template.agentName (on both top-level and metadata)", () => {
    const composed = composeAssistantPayload({
      template: rowFromSnapshot(),
      overrides: { name: "Custom Name" },
      joiningUserAccountId: "user-123",
    });
    expect(composed.name).toBe("Custom Name");
    const m = composed.metadata.template as Record<string, unknown>;
    expect(m.agentName).toBe("Custom Name");
  });

  test("caller profileImage override wins over template.avatarUrl in metadata", () => {
    const composed = composeAssistantPayload({
      template: rowFromSnapshot(),
      overrides: { profileImage: "https://cdn.example.com/custom.png" },
      joiningUserAccountId: "user-123",
    });
    const m = composed.metadata.template as Record<string, unknown>;
    expect(m.avatarUrl).toBe("https://cdn.example.com/custom.png");
  });
});
