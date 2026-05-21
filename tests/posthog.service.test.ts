/**
 * Unit tests for the PostHog metering service — actor attribution only.
 *
 * `resolveActor` decides which identifier becomes the event's distinctId
 * and what `actorKind` it advertises. Every event in the system flows
 * through this function, so a regression (e.g., accidentally swapping
 * two rungs of the precedence ladder) silently misattributes downstream
 * analytics. Pure-function unit tests are cheap insurance against that.
 *
 * Integration tests in agent-templates.executor.test.ts already cover
 * the wiring (postHogBase → capturePostHog) but they only exercise the
 * `account` / anonymous-sentinel path. These tests cover the device,
 * twitter, and unattributed rungs directly.
 */

import { describe, expect, test } from "vitest";
import {
  resolveActor,
  type PostHogCaptureProperties,
} from "@/api/v2/agent-templates/services/posthog";

describe("resolveActor — precedence ladder", () => {
  // Base props supplied with every case so the function has a `requestId`
  // (the rung-4 fallback) and won't return undefined accidentally.
  const baseProps: PostHogCaptureProperties = {
    requestId: "req-default",
    // GenerationMetrics fields — required by the type but irrelevant to
    // the ladder. Real values come from the LLM call at runtime.
    model: "test-model",
    promptTokens: 0,
    completionTokens: 0,
    latencyMs: 0,
  };

  test.each([
    {
      name: "account: ownerAccountId present and !isAnonymous wins over every other signal",
      props: {
        ownerAccountId: "00000000-0000-0000-0000-000000000001",
        isAnonymous: false,
        clientDeviceId: "device-abc",
        twitterUserId: "jack",
      },
      expected: {
        distinctId: "00000000-0000-0000-0000-000000000001",
        kind: "account" as const,
      },
    },
    {
      name: "device: anonymous owner + clientDeviceId → device rung",
      props: {
        ownerAccountId: "admin-sentinel-uuid",
        isAnonymous: true,
        clientDeviceId: "device-abc123",
      },
      expected: {
        distinctId: "device:device-abc123",
        kind: "device" as const,
      },
    },
    {
      name: "device wins over twitter when both are present (anonymous)",
      props: {
        isAnonymous: true,
        clientDeviceId: "device-abc",
        twitterUserId: "jack",
      },
      expected: { distinctId: "device:device-abc", kind: "device" as const },
    },
    {
      name: "twitter: anonymous + twitterUserId only → twitter rung",
      props: {
        isAnonymous: true,
        twitterUserId: "jack",
      },
      expected: { distinctId: "twitter:jack", kind: "twitter" as const },
    },
    {
      name: "unattributed: no actor signal at all → request:<requestId>",
      props: { isAnonymous: true },
      expected: {
        distinctId: "request:req-default",
        kind: "unattributed" as const,
      },
    },
    {
      name: "unattributed: missing ownerAccountId (undefined) falls through to request",
      props: {
        ownerAccountId: undefined,
        isAnonymous: false,
      },
      expected: {
        distinctId: "request:req-default",
        kind: "unattributed" as const,
      },
    },
  ])("$name", ({ props, expected }) => {
    const resolved = resolveActor({ ...baseProps, ...props });
    expect(resolved).toEqual(expected);
  });

  test("isAnonymous=true on a real-looking ownerAccountId still skips the account rung", () => {
    // Guards the executor contract: anonymous submissions are owned by
    // ADMIN_ACCOUNT_ID (a real UUID) but flagged isAnonymous. resolveActor
    // MUST honour the flag, not the presence of the field.
    const resolved = resolveActor({
      ...baseProps,
      ownerAccountId: "00000000-0000-0000-0000-000000000001",
      isAnonymous: true,
      clientDeviceId: "device-abc",
    });
    expect(resolved).toEqual({
      distinctId: "device:device-abc",
      kind: "device",
    });
  });
});
