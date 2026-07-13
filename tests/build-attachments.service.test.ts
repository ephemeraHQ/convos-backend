/**
 * Unit tests for the private-bucket attachment service. Mocks the S3 SDK at the
 * module boundary (the renew-batch.test.ts pattern) so no AWS access is needed.
 */

import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  classifyMime,
  decodeTextAttachment,
  getBuildObjectBytes,
  headBuildObject,
  maxBytesForKind,
  presignBuildUpload,
  TEXT_ATTACHMENT_MAX_CHARS,
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
    expect(classifyMime("application/zip")).toBeNull();
  });

  test("classifies the text family, and fails closed outside it", () => {
    expect(classifyMime("text/plain")).toBe("text");
    expect(classifyMime("text/markdown")).toBe("text");
    expect(classifyMime("text/csv")).toBe("text");
    expect(classifyMime("application/json")).toBe("text");

    // The allowlist is explicit, not a `text/*` prefix match: an unlisted
    // text-ish type is rejected rather than decoded on the client's say-so.
    expect(classifyMime("text/html")).toBeNull();

    // Office formats have no path in the generator yet.
    expect(
      classifyMime(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ),
    ).toBeNull();
  });
});

test("maxBytesForKind caps images tighter than pdf/audio", () => {
  expect(maxBytesForKind("image")).toBeLessThan(maxBytesForKind("pdf"));
  expect(maxBytesForKind("audio")).toBe(maxBytesForKind("pdf"));
  // The byte cap on a text file is only an upload guard — the character cap in
  // decodeTextAttachment is what actually bounds what reaches the prompt.
  expect(maxBytesForKind("text")).toBeLessThan(maxBytesForKind("pdf"));
});

describe("decodeTextAttachment", () => {
  const utf8 = (s: string) => new TextEncoder().encode(s);

  test("decodes UTF-8, including multi-byte characters", () => {
    expect(decodeTextAttachment(utf8("héllo — 世界"), "a.txt")).toBe(
      "héllo — 世界",
    );
  });

  test("rejects invalid UTF-8 rather than producing mojibake", () => {
    expect(() =>
      decodeTextAttachment(new Uint8Array([0xff, 0xfe, 0xfd]), "a.txt"),
    ).toThrow(/not valid UTF-8/i);
  });

  test("rejects a binary carrying an embedded NUL", () => {
    expect(() =>
      decodeTextAttachment(new Uint8Array([0x41, 0x00, 0x42]), "a.txt"),
    ).toThrow(/not a text file/i);
  });

  test("rejects an empty file", () => {
    expect(() => decodeTextAttachment(utf8("   \n"), "a.txt")).toThrow(
      /empty/i,
    );
  });

  test("truncation keeps the head and states how much was dropped", () => {
    const out = decodeTextAttachment(
      utf8("x".repeat(TEXT_ATTACHMENT_MAX_CHARS + 500)),
      "big.md",
    );
    expect(out).toContain("500 more characters not shown");
    expect(out.startsWith("x".repeat(TEXT_ATTACHMENT_MAX_CHARS))).toBe(true);
  });

  test("a file exactly at the cap is not truncated", () => {
    const out = decodeTextAttachment(
      utf8("x".repeat(TEXT_ATTACHMENT_MAX_CHARS)),
      "exact.md",
    );
    expect(out).toBe("x".repeat(TEXT_ATTACHMENT_MAX_CHARS));
  });
});

describe("presignBuildUpload", () => {
  test("mints a build/ key and sets ContentLength on the signed command", async () => {
    const { objectKey, uploadUrl } = await presignBuildUpload(
      "image/png",
      1024,
    );
    expect(objectKey).toMatch(/^build\/[\w-]+\.png$/);
    expect(uploadUrl).toBe("https://signed.example/put");

    // The exact byte count is set on the command; the presigner signs
    // Content-Length by default, so S3 caps the (anonymous) PUT itself.
    const [, command] = vi.mocked(getSignedUrl).mock.calls[0] as unknown as [
      unknown,
      { input: { ContentLength?: number } },
    ];
    expect(command.input.ContentLength).toBe(1024);
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

  test("rejects a key with a `..` segment under build/ without touching S3", async () => {
    await expect(headBuildObject("build/../secret")).rejects.toMatchObject({
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
