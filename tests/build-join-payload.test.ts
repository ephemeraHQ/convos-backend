import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentTemplate, PublishStatus } from "@prisma/client";
import { describe, expect, test } from "vitest";
import { buildJoinPayload } from "@/api/v2/agents/lib/build-join-payload";

// Cross-repo drift contract for the on-disk `TEMPLATE.json` shape.
//
// The payload's `template` field is the same JSON the assistant runtime
// (convos-assistants) writes to its on-disk `TEMPLATE.json`, and both
// writers must produce identical output for the same logical template
// so the runtime reads consistent state regardless of which side wrote
// it. The mirror fixture lives in convos-assistants at
//   runtime/convos-platform/skills/assistant-builder/scripts/handlers/__fixtures__/template-snapshot.json
// and is kept in sync manually — drift trips this test on either side.
const fixturePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "__fixtures__",
  "template-snapshot.json",
);
const snapshot = JSON.parse(fs.readFileSync(fixturePath, "utf8")) as Record<
  string,
  unknown
>;

// Reconstruct the AgentTemplate Prisma row that — when run through
// `buildJoinPayload` — should produce `template` equal to the fixture.
const rowFromSnapshot = (
  overrides: Partial<AgentTemplate> = {},
): AgentTemplate => ({
  id: snapshot.id as string,
  slug: snapshot.slug as string,
  // Not on the fixture (intentionally stripped from on-disk shape).
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

describe("buildJoinPayload", () => {
  test("payload.template matches the shared cross-repo on-disk snapshot", () => {
    const payload = buildJoinPayload({
      template: rowFromSnapshot(),
      joiningUserAccountId: "user-123",
    });

    // The `template` field IS the on-disk shape — full AgentTemplate
    // JSON minus `ownerAccountId`. Must match byte-for-byte.
    expect(payload.template as Record<string, unknown>).toEqual(snapshot);
  });

  test("template includes prompt verbatim (no longer split out)", () => {
    const payload = buildJoinPayload({
      template: rowFromSnapshot(),
      joiningUserAccountId: "user-123",
    });
    const t = payload.template as Record<string, unknown>;
    expect(t.prompt).toBe(snapshot.prompt as string);
  });

  test("top-level ownerAccountId is the joining user (not the template's owner)", () => {
    const payload = buildJoinPayload({
      template: rowFromSnapshot({ ownerAccountId: "template-owner-99" }),
      joiningUserAccountId: "user-123",
    });
    expect(payload.ownerAccountId).toBe("user-123");
  });

  test("template strips the template's own ownerAccountId entirely", () => {
    const payload = buildJoinPayload({
      template: rowFromSnapshot({ ownerAccountId: "template-owner-99" }),
      joiningUserAccountId: "user-123",
    });
    const t = payload.template as Record<string, unknown>;
    expect("ownerAccountId" in t).toBe(false);
  });

  test("template strips `owner` too — guard against serializer regression", () => {
    // If a future maintainer ever flips `serializeAgentTemplate` to
    // expand `owner` by default, this builder must not silently leak
    // the relation onto the wire — runtime doesn't expect it.
    const payload = buildJoinPayload({
      template: rowFromSnapshot(),
      joiningUserAccountId: "user-123",
    });
    const t = payload.template as Record<string, unknown>;
    expect("owner" in t).toBe(false);
  });

  test("publishedUrl is null for drafts (matches the fixture)", () => {
    const payload = buildJoinPayload({
      template: rowFromSnapshot(),
      joiningUserAccountId: "user-123",
    });
    const t = payload.template as Record<string, unknown>;
    expect(t.publishedUrl).toBeNull();
  });

  test("publishedUrl is populated for non-draft templates", () => {
    const payload = buildJoinPayload({
      template: rowFromSnapshot({
        status: "published",
        firstPublishedAt: new Date("2026-05-18T12:00:00.000Z"),
      }),
      joiningUserAccountId: "user-123",
    });
    const t = payload.template as Record<string, unknown>;
    expect(typeof t.publishedUrl).toBe("string");
    expect((t.publishedUrl as string).length).toBeGreaterThan(0);
  });
});
