/**
 * Unit tests for the private-bucket attachment service. Mocks the S3 SDK at the
 * module boundary (the renew-batch.test.ts pattern) so no AWS access is needed.
 */

import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  classifyMime,
  getBuildObjectBytes,
  headBuildObject,
  maxBytesForKind,
  presignBuildUpload,
} from "@/api/v2/agent-templates/services/build-attachments";

const mockSend = vi.fn(
  (_cmd: unknown): Promise<unknown> => Promise.resolve({}),
);

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    send(cmd: unknown) {
      return mockSend(cmd);
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

vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: vi.fn(() => Promise.resolve("https://signed.example/put")),
}));

afterEach(() => {
  mockSend.mockReset();
  vi.mocked(getSignedUrl).mockClear();
});

describe("classifyMime", () => {
  test("allows png/jpeg/pdf and the audio containers", () => {
    expect(classifyMime("image/png")).toBe("image");
    expect(classifyMime("image/jpeg")).toBe("image");
    expect(classifyMime("application/pdf")).toBe("pdf");
    expect(classifyMime("audio/mp4")).toBe("audio");
    expect(classifyMime("audio/m4a")).toBe("audio");
    expect(classifyMime("audio/webm")).toBe("audio");
  });

  test("normalizes case + strips parameters", () => {
    expect(classifyMime("IMAGE/PNG")).toBe("image");
    expect(classifyMime("audio/webm; codecs=opus")).toBe("audio");
  });

  test("rejects webp/gif (Rekognition can't read them) and unknown types", () => {
    expect(classifyMime("image/webp")).toBeNull();
    expect(classifyMime("image/gif")).toBeNull();
    expect(classifyMime("text/plain")).toBeNull();
  });
});

test("maxBytesForKind caps images tighter than pdf/audio", () => {
  expect(maxBytesForKind("image")).toBeLessThan(maxBytesForKind("pdf"));
  expect(maxBytesForKind("audio")).toBe(maxBytesForKind("pdf"));
});

describe("presignBuildUpload", () => {
  test("mints a build/ key, sets ContentLength, and signs content-length", async () => {
    const { objectKey, uploadUrl } = await presignBuildUpload(
      "image/png",
      1024,
    );
    expect(objectKey).toMatch(/^build\/[\w-]+\.png$/);
    expect(uploadUrl).toBe("https://signed.example/put");

    // The exact byte count is signed so S3 caps the (anonymous) PUT itself.
    const [, command, opts] = vi.mocked(getSignedUrl).mock
      .calls[0] as unknown as [
      unknown,
      { input: { ContentLength?: number } },
      { signableHeaders?: Set<string> },
    ];
    expect(command.input.ContentLength).toBe(1024);
    expect([...(opts.signableHeaders ?? [])]).toContain("content-length");
  });

  test("rejects an unsupported type with 400", async () => {
    await expect(presignBuildUpload("image/webp", 1024)).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  test("rejects a non-positive contentLength with 400", async () => {
    await expect(presignBuildUpload("image/png", 0)).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  test("rejects a contentLength over the per-kind cap with 400", async () => {
    await expect(
      presignBuildUpload("image/png", maxBytesForKind("image") + 1),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe("headBuildObject", () => {
  test("returns the object's size + content type", async () => {
    mockSend.mockResolvedValueOnce({
      ContentLength: 1234,
      ContentType: "image/png",
    });
    expect(await headBuildObject("build/abc.png")).toEqual({
      contentLength: 1234,
      contentType: "image/png",
    });
  });

  test("missing object → AppError 400", async () => {
    mockSend.mockRejectedValueOnce({
      name: "NotFound",
      $metadata: { httpStatusCode: 404 },
    });
    await expect(headBuildObject("build/missing.png")).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  test("rejects a key outside the build/ namespace without touching S3", async () => {
    await expect(headBuildObject("other/abc.png")).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe("getBuildObjectBytes", () => {
  test("returns the object bytes", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    mockSend.mockResolvedValueOnce({
      Body: { transformToByteArray: () => Promise.resolve(bytes) },
    });
    const out = await getBuildObjectBytes("build/abc.png");
    expect(Array.from(out)).toEqual([1, 2, 3]);
  });

  test("rejects a traversal-style key outside build/", async () => {
    await expect(getBuildObjectBytes("../secret")).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(mockSend).not.toHaveBeenCalled();
  });

  test("missing object → AppError 400", async () => {
    mockSend.mockRejectedValueOnce({
      name: "NoSuchKey",
      $metadata: { httpStatusCode: 404 },
    });
    await expect(
      getBuildObjectBytes("build/missing.png"),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  test("object with no Body → AppError 400", async () => {
    mockSend.mockResolvedValueOnce({ Body: null });
    await expect(getBuildObjectBytes("build/empty.png")).rejects.toMatchObject({
      statusCode: 400,
    });
  });
});
