/**
 * Unit tests for the attachment resolver — the stage that turns object-key
 * references into LLM-ready content. Mocks S3 at the SDK boundary and drives
 * image moderation / transcription / text moderation through their seams.
 */

import { afterEach, expect, test, vi } from "vitest";
import {
  AttachmentModerationError,
  attachmentsArraySchema,
  resolveAttachments,
} from "@/api/v2/agent-templates/services/attachment-resolver";
import { __resetImageModerationForTests } from "@/api/v2/agent-templates/services/image-moderation";
import { __resetModerationForTests } from "@/api/v2/agent-templates/services/moderation";
import { __resetTranscribeForTests } from "@/api/v2/agent-templates/services/transcribe";

const mockSend = vi.fn(
  (_cmd: unknown): Promise<unknown> => Promise.resolve({}),
);

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    send(cmd: unknown) {
      return mockSend(cmd);
    }
  },
  GetObjectCommand: class {
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
  PutObjectCommand: class {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  },
}));

/** Make `getBuildObjectBytes` return `bytes` for every GetObject in a test. */
function stubBytes(bytes: Uint8Array): void {
  mockSend.mockResolvedValue({
    Body: { transformToByteArray: () => Promise.resolve(bytes) },
  });
}

afterEach(() => {
  mockSend.mockReset();
  __resetImageModerationForTests(null);
  __resetTranscribeForTests(null);
  __resetModerationForTests(null);
});

test("image → data-uri block; moderation runs when moderate:true", async () => {
  stubBytes(new Uint8Array([1, 2, 3]));
  const checked: string[] = [];
  __resetImageModerationForTests((key) => {
    checked.push(key);
    return Promise.resolve({ allowed: true });
  });

  const out = await resolveAttachments(
    [{ objectKey: "build/a.png", mimeType: "image/png" }],
    { moderate: true },
  );

  expect(out.transcripts).toEqual([]);
  expect(out.attachments).toHaveLength(1);
  expect(out.attachments[0]).toMatchObject({
    kind: "image",
    mimeType: "image/png",
  });
  expect(out.attachments[0].dataUri).toMatch(/^data:image\/png;base64,/);
  expect(checked).toEqual(["build/a.png"]);
});

test("image flagged by moderation → AttachmentModerationError", async () => {
  stubBytes(new Uint8Array([1]));
  __resetImageModerationForTests(() =>
    Promise.resolve({ allowed: false, reason: "Explicit" }),
  );
  await expect(
    resolveAttachments([{ objectKey: "build/a.png", mimeType: "image/png" }], {
      moderate: true,
    }),
  ).rejects.toBeInstanceOf(AttachmentModerationError);
});

test("moderate:false skips image moderation entirely", async () => {
  stubBytes(new Uint8Array([1]));
  const spy = vi.fn(() => Promise.resolve({ allowed: false, reason: "x" }));
  __resetImageModerationForTests(spy);

  const out = await resolveAttachments(
    [{ objectKey: "build/a.png", mimeType: "image/png" }],
    { moderate: false },
  );

  expect(out.attachments).toHaveLength(1);
  expect(spy).not.toHaveBeenCalled();
});

test("pdf → file data-uri block carrying the filename", async () => {
  stubBytes(new Uint8Array([1]));
  const out = await resolveAttachments(
    [
      {
        objectKey: "build/d.pdf",
        mimeType: "application/pdf",
        filename: "report.pdf",
      },
    ],
    { moderate: true },
  );
  expect(out.attachments[0]).toMatchObject({
    kind: "pdf",
    filename: "report.pdf",
  });
  expect(out.attachments[0].dataUri).toMatch(/^data:application\/pdf;base64,/);
});

test("audio → transcript folded into transcripts, never an attachment block", async () => {
  stubBytes(new Uint8Array([1]));
  __resetTranscribeForTests(() => Promise.resolve("hello world"));
  const out = await resolveAttachments(
    [{ objectKey: "build/v.m4a", mimeType: "audio/mp4" }],
    { moderate: false },
  );
  expect(out.attachments).toEqual([]);
  expect(out.transcripts).toEqual(["hello world"]);
});

test("audio transcript blocked by content moderation → error", async () => {
  stubBytes(new Uint8Array([1]));
  __resetTranscribeForTests(() => Promise.resolve("bad stuff"));
  __resetModerationForTests(() =>
    Promise.resolve({ allowed: false, reason: "blocked" }),
  );
  await expect(
    resolveAttachments([{ objectKey: "build/v.m4a", mimeType: "audio/mp4" }], {
      moderate: true,
    }),
  ).rejects.toBeInstanceOf(AttachmentModerationError);
});

test("over-cap image → throws before any moderation", async () => {
  stubBytes(new Uint8Array(11 * 1024 * 1024)); // > 10 MB image cap
  const spy = vi.fn(() => Promise.resolve({ allowed: true }));
  __resetImageModerationForTests(spy);
  await expect(
    resolveAttachments(
      [{ objectKey: "build/big.png", mimeType: "image/png" }],
      {
        moderate: true,
      },
    ),
  ).rejects.toThrow(/size limit/);
  expect(spy).not.toHaveBeenCalled();
});

test("aggregate over the total cap → throws (executor-side re-check)", async () => {
  // Each PDF is under the 25 MiB per-file cap, but 5 × 24 MiB = 120 MiB blows
  // the 100 MiB aggregate cap. The stub reuses one buffer, so only 24 MiB is
  // actually allocated.
  stubBytes(new Uint8Array(24 * 1024 * 1024));
  const refs = Array.from({ length: 5 }, (_, i) => ({
    objectKey: `build/doc-${i}.pdf`,
    mimeType: "application/pdf",
  }));
  await expect(resolveAttachments(refs, { moderate: false })).rejects.toThrow(
    /total size limit/,
  );
});

test("unsupported mime → throws", async () => {
  await expect(
    resolveAttachments([{ objectKey: "build/x.gif", mimeType: "image/gif" }], {
      moderate: false,
    }),
  ).rejects.toThrow(/Unsupported/);
});

test("attachmentsArraySchema rejects duplicate objectKeys", () => {
  const dup = [
    { objectKey: "build/a.png", mimeType: "image/png" },
    { objectKey: "build/a.png", mimeType: "image/png" },
  ];
  const res = attachmentsArraySchema.safeParse(dup);
  expect(res.success).toBe(false);
  if (!res.success) {
    expect(res.error.issues[0].message).toMatch(/Duplicate attachment/);
  }
});

test("attachmentsArraySchema accepts distinct objectKeys", () => {
  const ok = [
    { objectKey: "build/a.png", mimeType: "image/png" },
    { objectKey: "build/b.png", mimeType: "image/png" },
  ];
  expect(attachmentsArraySchema.safeParse(ok).success).toBe(true);
});

test("mixed batch resolves images/pdfs as blocks and audio as transcripts", async () => {
  stubBytes(new Uint8Array([1]));
  __resetImageModerationForTests(() => Promise.resolve({ allowed: true }));
  __resetTranscribeForTests(() => Promise.resolve("spoken note"));

  const out = await resolveAttachments(
    [
      { objectKey: "build/a.png", mimeType: "image/png" },
      { objectKey: "build/d.pdf", mimeType: "application/pdf" },
      { objectKey: "build/v.m4a", mimeType: "audio/mp4" },
    ],
    { moderate: true },
  );

  expect(out.attachments.map((a) => a.kind).sort()).toEqual(["image", "pdf"]);
  expect(out.transcripts).toEqual(["spoken note"]);
});
