/**
 * Tests for GET /api/v2/agent-templates/attachments/presigned. Drives the
 * handler directly with a stubbed req/res and mocks the S3 presigner.
 */

import type { Request, Response } from "express";
import { afterEach, expect, test, vi } from "vitest";
import { buildAttachmentPresignedHandler } from "@/api/v2/agent-templates/handlers/build-attachment-presigned";

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    send() {
      return Promise.resolve({});
    }
  },
  PutObjectCommand: class {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  },
}));

vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: vi.fn(() => Promise.resolve("https://signed.example/put")),
}));

interface MockRes {
  statusCode: number;
  body: unknown;
  status: (c: number) => MockRes;
  json: (b: unknown) => MockRes;
  set: (h: unknown) => MockRes;
}

function mockRes(): MockRes {
  const res = { statusCode: 200, body: undefined } as MockRes;
  res.status = (c) => {
    res.statusCode = c;
    return res;
  };
  res.json = (b) => {
    res.body = b;
    return res;
  };
  res.set = () => res;
  return res;
}

const log = { error: vi.fn(), info: vi.fn() };

function call(res: MockRes, query: Record<string, unknown>): Promise<void> {
  const req = { query, log } as unknown as Request;
  return buildAttachmentPresignedHandler(req, res as unknown as Response);
}

afterEach(() => {
  log.error.mockReset();
});

test("missing contentType → 400", async () => {
  const res = mockRes();
  await call(res, {});
  expect(res.statusCode).toBe(400);
});

test("unsupported contentType → 400", async () => {
  const res = mockRes();
  await call(res, { contentType: "image/webp" });
  expect(res.statusCode).toBe(400);
});

test("missing contentLength → 400", async () => {
  const res = mockRes();
  await call(res, { contentType: "image/png" });
  expect(res.statusCode).toBe(400);
});

test("non-positive / non-numeric contentLength → 400", async () => {
  const zero = mockRes();
  await call(zero, { contentType: "image/png", contentLength: "0" });
  expect(zero.statusCode).toBe(400);

  const nan = mockRes();
  await call(nan, { contentType: "image/png", contentLength: "huge" });
  expect(nan.statusCode).toBe(400);
});

test("contentLength over the per-kind cap → 400", async () => {
  const res = mockRes();
  // Image cap is 10 MiB; one byte over must be rejected before a key is minted.
  await call(res, {
    contentType: "image/png",
    contentLength: String(10 * 1024 * 1024 + 1),
  });
  expect(res.statusCode).toBe(400);
});

test("supported contentType + in-cap contentLength → objectKey + uploadUrl, no public asset URL", async () => {
  const res = mockRes();
  await call(res, { contentType: "image/png", contentLength: "1024" });
  expect(res.statusCode).toBe(200);
  const body = res.body as { objectKey: string; uploadUrl: string };
  expect(body.objectKey).toMatch(/^build\//);
  expect(body.uploadUrl).toBe("https://signed.example/put");
  expect(body).not.toHaveProperty("assetUrl");
});
