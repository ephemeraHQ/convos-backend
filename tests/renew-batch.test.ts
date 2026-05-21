import type { Server } from "node:http";
import express from "express";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import { jsonMiddleware } from "@/middleware/json";
import { pinoMiddleware } from "@/middleware/pino";

// Track S3 send calls
interface MockS3Command {
  input: {
    Bucket?: string;
    Key?: string;
    CopySource?: string;
    MetadataDirective?: string;
  };
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mockS3Send = vi.fn((_cmd: any) => Promise.resolve({}));

// Mock S3 before handler module loads
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    send(command: any) {
      return mockS3Send(command);
    }
  },
  DeleteObjectCommand: class DeleteObjectCommand {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  },
  HeadBucketCommand: class HeadBucketCommand {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  },
  HeadObjectCommand: class HeadObjectCommand {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  },
  ListObjectsV2Command: class ListObjectsV2Command {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  },
  PutObjectCommand: class PutObjectCommand {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  },
  CopyObjectCommand: class {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    input: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(input: any) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      this.input = input;
    }
  },
}));

// Import after mocking
const { renewBatchHandler } =
  await import("@/api/v2/assets/handlers/renew-batch");

const app = express();
app.use(pinoMiddleware);
app.use(jsonMiddleware);

// Fake auth middleware — sets deviceId on res.locals
app.use("/api/v2/assets", (req, res, next) => {
  const authToken = req.header("X-Convos-AuthToken");
  if (!authToken) {
    res.status(401).json({ error: "Missing auth token" });
    return;
  }
  res.locals.deviceId = "test-device-123";
  next();
});

app.post("/api/v2/assets/renew-batch", renewBatchHandler);

describe("POST /api/v2/assets/renew-batch", () => {
  let server: Server;
  const baseURL = "http://localhost:4005";

  beforeAll(async () => {
    await new Promise<void>((resolve) => {
      server = app.listen(4005, () => {
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  });

  beforeEach(() => {
    // Default: mock REJECTS so tests only pass if the handler
    // actually calls S3 and handles the response correctly.
    mockS3Send = vi.fn(() => Promise.reject(new Error("unmocked S3 call")));
  });

  const post = (body: unknown, headers?: Record<string, string>) =>
    fetch(`${baseURL}/api/v2/assets/renew-batch`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Convos-AuthToken": "valid-token",
        ...headers,
      },
      body: JSON.stringify(body),
    });

  // --- Auth ---

  test("should return 401 without auth token", async () => {
    const res = await fetch(`${baseURL}/api/v2/assets/renew-batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ assetKeys: ["test.bin"] }),
    });

    expect(res.status).toBe(401);
  });

  // --- Validation (never reaches S3) ---

  test("should return 400 for empty assetKeys array", async () => {
    const res = await post({ assetKeys: [] });

    expect(res.status).toBe(400);
    const data = (await res.json()) as { error: string };
    expect(data.error).toContain("non-empty");
    expect(mockS3Send).not.toHaveBeenCalled();
  });

  test("should return 400 for missing assetKeys", async () => {
    const res = await post({});

    expect(res.status).toBe(400);
    expect(mockS3Send).not.toHaveBeenCalled();
  });

  test("should return 400 for batch size > 100", async () => {
    const keys = Array.from({ length: 101 }, (_, i) => `key-${i}.bin`);
    const res = await post({ assetKeys: keys });

    expect(res.status).toBe(400);
    const data = (await res.json()) as { error: string };
    expect(data.error).toContain("Maximum 100");
    expect(mockS3Send).not.toHaveBeenCalled();
  });

  test("should return 400 for empty string key in array", async () => {
    const res = await post({ assetKeys: ["valid.bin", ""] });

    expect(res.status).toBe(400);
    expect(mockS3Send).not.toHaveBeenCalled();
  });

  // --- S3 interaction ---

  test("should pass correct parameters to CopyObjectCommand", async () => {
    mockS3Send = vi.fn(() => Promise.resolve({}));

    const res = await post({ assetKeys: ["abc123.bin"] });

    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      renewed: number;
      failed: number;
      results: { key: string; success: boolean }[];
    };
    expect(data.renewed).toBe(1);
    expect(data.results[0].success).toBe(true);

    // Verify CopyObjectCommand was constructed correctly
    expect(mockS3Send).toHaveBeenCalledTimes(1);
    const cmd = mockS3Send.mock.calls[0][0] as MockS3Command;
    expect(cmd.input.Bucket).toBe("test-public-assets-bucket");
    expect(cmd.input.Key).toBe("abc123.bin");
    expect(cmd.input.CopySource).toBe("test-public-assets-bucket/abc123.bin");
    expect(cmd.input.MetadataDirective).toBe("COPY");
  });

  test("should URL-encode the key in CopySource", async () => {
    mockS3Send = vi.fn(() => Promise.resolve({}));

    const res = await post({ assetKeys: ["file with spaces.bin"] });

    expect(res.status).toBe(200);
    expect(mockS3Send).toHaveBeenCalledTimes(1);
    const cmd = mockS3Send.mock.calls[0][0] as MockS3Command;
    expect(cmd.input.Key).toBe("file with spaces.bin");
    expect(cmd.input.CopySource).toBe(
      "test-public-assets-bucket/file%20with%20spaces.bin",
    );
  });

  test("should call S3 once per valid key", async () => {
    mockS3Send = vi.fn(() => Promise.resolve({}));

    const res = await post({ assetKeys: ["a.bin", "b.bin", "c.bin"] });

    expect(res.status).toBe(200);
    const data = (await res.json()) as { renewed: number; failed: number };
    expect(data.renewed).toBe(3);
    expect(data.failed).toBe(0);
    expect(mockS3Send).toHaveBeenCalledTimes(3);
  });

  // --- S3 error classification ---

  test("should classify NoSuchKey as not_found", async () => {
    mockS3Send = vi.fn(() => {
      const err = new Error("NoSuchKey");
      err.name = "NoSuchKey";
      return Promise.reject(err);
    });

    const res = await post({ assetKeys: ["missing.bin"] });

    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      renewed: number;
      failed: number;
      results: { key: string; success: boolean; error?: string }[];
    };
    expect(data.renewed).toBe(0);
    expect(data.failed).toBe(1);
    expect(data.results[0].error).toBe("not_found");
    expect(mockS3Send).toHaveBeenCalledTimes(1);
  });

  test("should classify NotFound as not_found", async () => {
    mockS3Send = vi.fn(() => {
      const err = new Error("NotFound");
      err.name = "NotFound";
      return Promise.reject(err);
    });

    const res = await post({ assetKeys: ["missing.bin"] });

    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      results: { error?: string }[];
    };
    expect(data.results[0].error).toBe("not_found");
  });

  test("should classify unknown errors as internal_error", async () => {
    // Default mock throws "unmocked S3 call" — not NoSuchKey or NotFound
    const res = await post({ assetKeys: ["broken.bin"] });

    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      renewed: number;
      failed: number;
      results: { key: string; success: boolean; error?: string }[];
    };
    expect(data.renewed).toBe(0);
    expect(data.failed).toBe(1);
    expect(data.results[0].error).toBe("internal_error");
    expect(mockS3Send).toHaveBeenCalledTimes(1);
  });

  test("should handle mixed success and failure per key", async () => {
    mockS3Send = vi.fn((cmd: MockS3Command) => {
      if (cmd.input.Key === "missing.bin") {
        const err = new Error("NoSuchKey");
        err.name = "NoSuchKey";
        return Promise.reject(err);
      }
      return Promise.resolve({});
    });

    const res = await post({
      assetKeys: ["exists1.bin", "missing.bin", "exists2.bin"],
    });

    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      renewed: number;
      failed: number;
      results: { key: string; success: boolean; error?: string }[];
    };
    expect(data.renewed).toBe(2);
    expect(data.failed).toBe(1);
    expect(mockS3Send).toHaveBeenCalledTimes(3);

    const missingResult = data.results.find((r) => r.key === "missing.bin");
    const exists1Result = data.results.find((r) => r.key === "exists1.bin");
    const exists2Result = data.results.find((r) => r.key === "exists2.bin");
    expect(missingResult?.error).toBe("not_found");
    expect(exists1Result?.success).toBe(true);
    expect(exists2Result?.success).toBe(true);
  });

  // --- Key validation (never reaches S3) ---

  test("should reject keys with path traversal", async () => {
    const res = await post({ assetKeys: ["../secret.bin"] });

    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      results: { error?: string }[];
    };
    expect(data.results[0].error).toBe("invalid_key");
    expect(mockS3Send).not.toHaveBeenCalled();
  });

  test("should reject keys with embedded path traversal", async () => {
    const res = await post({ assetKeys: ["foo/../bar.bin"] });

    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      results: { error?: string }[];
    };
    expect(data.results[0].error).toBe("invalid_key");
    expect(mockS3Send).not.toHaveBeenCalled();
  });

  test("should reject keys starting with /", async () => {
    const res = await post({ assetKeys: ["/etc/passwd"] });

    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      results: { error?: string }[];
    };
    expect(data.results[0].error).toBe("invalid_key");
    expect(mockS3Send).not.toHaveBeenCalled();
  });

  test("should reject keys exceeding 1024 characters", async () => {
    const longKey = "a".repeat(1025) + ".bin";
    const res = await post({ assetKeys: [longKey] });

    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      results: { error?: string }[];
    };
    expect(data.results[0].error).toBe("invalid_key");
    expect(mockS3Send).not.toHaveBeenCalled();
  });

  test("should skip invalid keys but still call S3 for valid ones", async () => {
    mockS3Send = vi.fn(() => Promise.resolve({}));

    const res = await post({
      assetKeys: ["valid.bin", "../traversal.bin", "also-valid.bin"],
    });

    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      renewed: number;
      failed: number;
      results: { key: string; success: boolean; error?: string }[];
    };
    expect(data.renewed).toBe(2);
    expect(data.failed).toBe(1);
    // Only 2 S3 calls — invalid key was skipped
    expect(mockS3Send).toHaveBeenCalledTimes(2);

    const traversalResult = data.results.find(
      (r) => r.key === "../traversal.bin",
    );
    expect(traversalResult?.error).toBe("invalid_key");
  });

  // --- Batch size boundary ---

  test("should accept exactly 100 keys", async () => {
    mockS3Send = vi.fn(() => Promise.resolve({}));
    const keys = Array.from({ length: 100 }, (_, i) => `key-${i}.bin`);

    const res = await post({ assetKeys: keys });

    expect(res.status).toBe(200);
    const data = (await res.json()) as { renewed: number };
    expect(data.renewed).toBe(100);
    expect(mockS3Send).toHaveBeenCalledTimes(100);
  });
});
