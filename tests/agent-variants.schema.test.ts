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
    expect(parsed.expiresAt).toBeNull();
  });

  test("defaults status, nullable axes, and expiresAt when omitted", () => {
    const parsed = AgentVariantUpsertSchema.parse({
      slug: "pr-1",
      label: "X",
      whatToTest: "y",
      prUrl: "https://github.com/x/y/pull/1",
      branch: "b",
      commit: "c",
    });
    expect(parsed.status).toBe("building");
    expect(parsed.assistantWorkerUrl).toBeNull();
    expect(parsed.builderPromptSlug).toBeNull();
    expect(parsed.expiresAt).toBeNull();
  });

  test("rejects an unknown key (strict; server-to-server route)", () => {
    expect(() =>
      AgentVariantUpsertSchema.parse({ ...valid, bogus: 1 }),
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
      prUrl: "https://github.com/x/y/pull/9",
      branch: "b",
      commit: "c",
      expiresAt: null,
      createdAt: new Date("2026-06-24T12:00:00.000Z"),
      updatedAt: new Date("2026-06-24T12:00:00.000Z"),
    });
    expect(out.assistantWorkerUrl).toBeNull();
    expect(out.expiresAt).toBeNull();
    expect(out.createdAt).toBe("2026-06-24T12:00:00.000Z");
    // updatedAt is internal — not part of the wire shape.
    expect("updatedAt" in out).toBe(false);
  });
});
