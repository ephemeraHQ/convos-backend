/**
 * Unit tests for the Rekognition image-moderation service. Mocks the
 * Rekognition SDK at the module boundary.
 */

import { afterEach, expect, test, vi } from "vitest";
import { checkImage } from "@/api/v2/agent-templates/services/image-moderation";

const mockSend = vi.fn(
  (_cmd: unknown): Promise<unknown> => Promise.resolve({}),
);

vi.mock("@aws-sdk/client-rekognition", () => ({
  RekognitionClient: class {
    send(cmd: unknown) {
      return mockSend(cmd);
    }
  },
  DetectModerationLabelsCommand: class {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  },
}));

afterEach(() => {
  mockSend.mockReset();
});

test("no moderation labels → allowed", async () => {
  mockSend.mockResolvedValueOnce({ ModerationLabels: [] });
  expect(await checkImage("build/a.png")).toEqual({ allowed: true });
});

test("a label → blocked, with the top-level category as the reason", async () => {
  mockSend.mockResolvedValueOnce({
    ModerationLabels: [
      { Name: "Explicit Nudity", ParentName: "Explicit", Confidence: 99 },
    ],
  });
  const r = await checkImage("build/a.png");
  expect(r.allowed).toBe(false);
  expect(r.reason).toBe("Explicit");
});

test("queries the object by S3 reference, not bytes", async () => {
  mockSend.mockResolvedValueOnce({ ModerationLabels: [] });
  await checkImage("build/a.png");
  const cmd = mockSend.mock.calls[0][0] as { input: { Image?: unknown } };
  expect(cmd.input).toMatchObject({
    Image: { S3Object: { Name: "build/a.png" } },
  });
});

test("Rekognition error → fail open (allowed)", async () => {
  mockSend.mockRejectedValueOnce(new Error("boom"));
  expect(await checkImage("build/a.png")).toEqual({ allowed: true });
});
