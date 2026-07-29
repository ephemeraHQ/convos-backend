import type { Request, Response } from "express";
import { afterEach, expect, test, vi } from "vitest";
import { getAgentPresignedUrlHandler } from "@/api/v2/agents/assets/handlers/get-presigned-url";

const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const { getSignedUrl } = vi.hoisted(() => ({
  getSignedUrl: vi.fn((_client: unknown, _command: unknown) =>
    Promise.resolve("https://signed.example/put"),
  ),
}));

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    config = {};
  },
  PutObjectCommand: class {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  },
}));

vi.mock("@aws-sdk/s3-request-presigner", () => ({ getSignedUrl }));

type MockResponse = Pick<Response, "json" | "set" | "status"> & {
  body?: unknown;
  locals: Response["locals"];
  statusCode: number;
};

const response = (): MockResponse => {
  const res = {
    locals: { accountId: ACCOUNT_ID },
    statusCode: 200,
  } as MockResponse;
  res.status = (statusCode) => {
    res.statusCode = statusCode;
    return res as Response;
  };
  res.json = (body) => {
    res.body = body;
    return res as Response;
  };
  res.set = () => res as Response;
  return res;
};

afterEach(() => {
  getSignedUrl.mockClear();
});

test("mints an avatar key inside the authenticated account namespace", async () => {
  const req = {
    query: {},
    log: { error: vi.fn(), info: vi.fn() },
  } as unknown as Request;
  const res = response();

  await getAgentPresignedUrlHandler(req, res as Response);

  expect(res.statusCode).toBe(200);
  const body = res.body as { assetUrl: string; objectKey: string };
  expect(body.objectKey).toMatch(
    new RegExp(
      `^a/${ACCOUNT_ID}/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`,
    ),
  );
  const command = getSignedUrl.mock.calls[0]?.[1] as
    | { input?: { Key?: string } }
    | undefined;
  expect(command?.input?.Key).toBe(body.objectKey);
});
