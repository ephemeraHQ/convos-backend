import { describe, expect, test } from "vitest";
import { AgentVariantUpsertSchema } from "@/api/v2/agent-variants/schemas";
import { serializeAgentVariant } from "@/api/v2/agent-variants/serialize";

const valid = {
  slug: "pr-1234",
  label: "Q+A",
  whatToTest: "Agent asks clarifying questions before building.",
  status: "ready",
  assistantWorkerUrl: "https://ephemeral-pr-1234.convos.fun",
  builderPromptSlug: "qa-flow-v2",
  prUrl: "https://github.com/xmtplabs/convos-assistants/pull/1234",
  branch: "saul/qa-flow",
  commit: "b9adb65",
};

describe("AgentVariantUpsertSchema", () => {
  test("accepts a full valid body", () => {
    const parsed = AgentVariantUpsertSchema.parse(valid);
    expect(parsed.slug).toBe("pr-1234");
    expect(parsed.assistantWorkerUrl).toBe(
      "https://ephemeral-pr-1234.convos.fun",
    );
    // expiresAt is omitted from `valid`; optional fields are not defaulted.
    expect(parsed.expiresAt).toBeUndefined();
  });

  test("leaves omitted optional fields undefined (not defaulted)", () => {
    // Optional, NOT defaulted: omitted fields stay undefined so a partial upsert
    // preserves the stored value (the handler spreads ...rest into the Prisma
    // update, which skips undefined). Create-time gaps fall back to the Prisma
    // column defaults instead.
    const parsed = AgentVariantUpsertSchema.parse({
      slug: "pr-1",
      label: "X",
      whatToTest: "y",
      prUrl: "https://github.com/x/y/pull/1",
      branch: "b",
      commit: "c",
    });
    expect(parsed.status).toBeUndefined();
    expect(parsed.assistantWorkerUrl).toBeUndefined();
    expect(parsed.builderPromptSlug).toBeUndefined();
    expect(parsed.skipCredits).toBeUndefined();
    expect(parsed.expiresAt).toBeUndefined();
  });

  test("rejects an unknown key (strict; server-to-server route)", () => {
    expect(() =>
      AgentVariantUpsertSchema.parse({ ...valid, bogus: 1 }),
    ).toThrow();
  });

  test("accepts a boolean skipCredits and rejects other types", () => {
    expect(
      AgentVariantUpsertSchema.parse({ ...valid, skipCredits: false })
        .skipCredits,
    ).toBe(false);
    expect(
      AgentVariantUpsertSchema.parse({ ...valid, skipCredits: true })
        .skipCredits,
    ).toBe(true);
    expect(() =>
      AgentVariantUpsertSchema.parse({ ...valid, skipCredits: "false" }),
    ).toThrow();
  });

  test("rejects an out-of-set status", () => {
    expect(() =>
      AgentVariantUpsertSchema.parse({ ...valid, status: "live" }),
    ).toThrow();
  });

  test("rejects a non-url assistantWorkerUrl and prUrl", () => {
    expect(() =>
      AgentVariantUpsertSchema.parse({ ...valid, assistantWorkerUrl: "nope" }),
    ).toThrow();
    expect(() =>
      AgentVariantUpsertSchema.parse({ ...valid, prUrl: "nope" }),
    ).toThrow();
  });

  test("rejects a slug with illegal characters", () => {
    expect(() =>
      AgentVariantUpsertSchema.parse({ ...valid, slug: "PR_1234" }),
    ).toThrow();
  });

  test("coerces expiresAt to a Date", () => {
    const parsed = AgentVariantUpsertSchema.parse({
      ...valid,
      expiresAt: "2026-07-01T00:00:00.000Z",
    });
    expect(parsed.expiresAt).toBeInstanceOf(Date);
  });
});

describe("serializeAgentVariant", () => {
  test("emits ISO date strings and preserves nulls", () => {
    const out = serializeAgentVariant({
      slug: "pr-9",
      label: "L",
      whatToTest: "w",
      status: "building",
      assistantWorkerUrl: null,
      builderPromptSlug: null,
      skipCredits: false,
      prUrl: "https://github.com/x/y/pull/9",
      branch: "b",
      commit: "c",
      expiresAt: null,
      createdAt: new Date("2026-06-24T12:00:00.000Z"),
      updatedAt: new Date("2026-06-24T12:00:00.000Z"),
    });
    expect(out.skipCredits).toBe(false);
    expect(out.assistantWorkerUrl).toBeNull();
    expect(out.expiresAt).toBeNull();
    expect(out.createdAt).toBe("2026-06-24T12:00:00.000Z");
    // updatedAt is internal — not part of the wire shape.
    expect("updatedAt" in out).toBe(false);
  });
});
