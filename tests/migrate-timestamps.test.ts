import type { Server } from "node:http";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import express from "express";
import { jsonMiddleware } from "@/middleware/json";
import { lifecycleTestAuthMiddleware } from "@/middleware/lifecycleTestAuth";
import { pinoMiddleware } from "@/middleware/pino";

interface MockCommandInput {
  Bucket?: string;
  MaxKeys?: number;
  ContinuationToken?: string;
  CopySource?: string;
  Key?: string;
  MetadataDirective?: string;
  Metadata?: Record<string, string>;
  ContentType?: string;
}

interface MockCommand {
  input: MockCommandInput;
  constructor: {
    name: string;
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mockS3Send = mock((_cmd: any) => Promise.resolve({}));

// Mock S3 before handler module loads.
void mock.module("@aws-sdk/client-s3", () => ({
  S3Client: class {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    send(command: any) {
      return mockS3Send(command);
    }
  },
  HeadBucketCommand: class {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    input: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(input: any) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      this.input = input;
    }
  },
  ListObjectsV2Command: class {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    input: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(input: any) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      this.input = input;
    }
  },
  HeadObjectCommand: class {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    input: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(input: any) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
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

const { migrateTimestampsHandler } = await import(
  "@/api/v2/assets/handlers/migrate-timestamps"
);

const app = express();
app.use(pinoMiddleware);
app.use(jsonMiddleware);
app.post(
  "/api/v2/assets/test/migrate-timestamps",
  lifecycleTestAuthMiddleware,
  migrateTimestampsHandler,
);

function commandName(command: unknown): string {
  return (command as MockCommand).constructor.name;
}

function daysAgo(days: number): Date {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date;
}

describe("POST /api/v2/assets/test/migrate-timestamps", () => {
  let server: Server;
  const baseURL = "http://localhost:4004";

  beforeAll(async () => {
    await new Promise<void>((resolve) => {
      server = app.listen(4004, () => {
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
    process.env.LIFECYCLE_TEST_TOKEN =
      "test-secret-token-for-lifecycle-testing-minimum-32-chars";
    mockS3Send = mock(() => Promise.reject(new Error("unmocked S3 call")));
  });

  const post = (query = "", token?: string) =>
    fetch(`${baseURL}/api/v2/assets/test/migrate-timestamps${query}`, {
      method: "POST",
      headers: token
        ? {
            Authorization: `Bearer ${token}`,
          }
        : undefined,
    });

  test("rejects requests without lifecycle token", async () => {
    const res = await post();

    expect(res.status).toBe(401);
    expect(mockS3Send).not.toHaveBeenCalled();
  });

  test("defaults to dryRun=true and does not copy objects", async () => {
    mockS3Send = mock((command: MockCommand) => {
      if (commandName(command) === "HeadBucketCommand") {
        return Promise.resolve({});
      }
      if (commandName(command) === "ListObjectsV2Command") {
        return Promise.resolve({
          IsTruncated: false,
          Contents: [
            { Key: "old.bin", LastModified: daysAgo(40) },
            { Key: "fresh.bin", LastModified: daysAgo(2) },
          ],
        });
      }
      throw new Error(`unexpected command: ${commandName(command)}`);
    });

    const res = await post(
      "",
      "test-secret-token-for-lifecycle-testing-minimum-32-chars",
    );

    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      dryRun: boolean;
      processedPages: number;
      nextContinuationToken: string | null;
      done: boolean;
      total: number;
      eligible: number;
      skipped: number;
      renewed: number;
      failed: number;
      verified: unknown[];
    };
    expect(data.dryRun).toBe(true);
    expect(data.total).toBe(2);
    expect(data.eligible).toBe(1);
    expect(data.skipped).toBe(1);
    expect(data.renewed).toBe(0);
    expect(data.failed).toBe(0);
    expect(data.verified).toEqual([]);
    expect(data.processedPages).toBe(1);
    expect(data.nextContinuationToken).toBeNull();
    expect(data.done).toBe(true);

    const commands = mockS3Send.mock.calls.map((call) => commandName(call[0]));
    expect(commands).not.toContain("CopyObjectCommand");
  });

  test("rejects invalid query parameters", async () => {
    const res = await post(
      "?concurrency=999&olderThanDays=366&maxKeys=1001",
      "test-secret-token-for-lifecycle-testing-minimum-32-chars",
    );

    expect(res.status).toBe(400);
    expect(mockS3Send).not.toHaveBeenCalled();
  });

  test("copies eligible objects with COPY metadata directive", async () => {
    mockS3Send = mock((command: MockCommand) => {
      if (commandName(command) === "HeadBucketCommand") {
        return Promise.resolve({});
      }

      if (commandName(command) === "ListObjectsV2Command") {
        return Promise.resolve({
          IsTruncated: false,
          Contents: [
            {
              Key: "folder with space/file+name.bin",
              LastModified: daysAgo(60),
            },
            { Key: "new.bin", LastModified: daysAgo(1) },
          ],
        });
      }

      if (commandName(command) === "HeadObjectCommand") {
        return Promise.resolve({
          LastModified: new Date(),
          Metadata: { source: "test" },
          ContentType: "application/octet-stream",
        });
      }

      if (commandName(command) === "CopyObjectCommand") {
        return Promise.resolve({});
      }

      throw new Error(`unexpected command: ${commandName(command)}`);
    });

    const res = await post(
      "?dryRun=false",
      "test-secret-token-for-lifecycle-testing-minimum-32-chars",
    );

    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      dryRun: boolean;
      processedPages: number;
      nextContinuationToken: string | null;
      done: boolean;
      total: number;
      eligible: number;
      skipped: number;
      renewed: number;
      failed: number;
      verified: { key: string; lastModified: string }[];
    };
    expect(data.dryRun).toBe(false);
    expect(data.total).toBe(2);
    expect(data.eligible).toBe(1);
    expect(data.skipped).toBe(1);
    expect(data.renewed).toBe(1);
    expect(data.failed).toBe(0);
    expect(data.verified.length).toBe(1);
    expect(data.processedPages).toBe(1);
    expect(data.nextContinuationToken).toBeNull();
    expect(data.done).toBe(true);

    const copyCall = mockS3Send.mock.calls.find(
      (call) => commandName(call[0]) === "CopyObjectCommand",
    );
    expect(copyCall).toBeDefined();

    const copyCommand = copyCall?.[0] as MockCommand;
    expect(copyCommand.input.MetadataDirective).toBe("COPY");
    expect(copyCommand.input.Metadata).toEqual({ source: "test" });
    expect(copyCommand.input.ContentType).toBe("application/octet-stream");
    expect(copyCommand.input.Key).toBe("folder with space/file+name.bin");
    expect(copyCommand.input.CopySource).toBe(
      "test-public-assets-bucket/folder with space/file+name.bin",
    );
  });

  test("handles paginated listing and continues after individual copy failures", async () => {
    mockS3Send = mock((command: MockCommand) => {
      if (commandName(command) === "HeadBucketCommand") {
        return Promise.resolve({});
      }

      if (commandName(command) === "ListObjectsV2Command") {
        if (!command.input.ContinuationToken) {
          return Promise.resolve({
            IsTruncated: true,
            NextContinuationToken: "page-2-token",
            Contents: [
              { Key: "fails.bin", LastModified: daysAgo(50) },
              { Key: "skip.bin", LastModified: daysAgo(1) },
            ],
          });
        }
        return Promise.resolve({
          IsTruncated: false,
          Contents: [{ Key: "ok.bin", LastModified: daysAgo(50) }],
        });
      }

      if (commandName(command) === "HeadObjectCommand") {
        return Promise.resolve({
          LastModified: new Date(),
          Metadata: {},
          ContentType: "application/octet-stream",
        });
      }

      if (
        commandName(command) === "CopyObjectCommand" &&
        command.input.Key === "fails.bin"
      ) {
        const error = new Error("copy failed");
        error.name = "AccessDenied";
        return Promise.reject(error);
      }

      if (commandName(command) === "CopyObjectCommand") {
        return Promise.resolve({});
      }

      throw new Error(`unexpected command: ${commandName(command)}`);
    });

    const res = await post(
      "?dryRun=false",
      "test-secret-token-for-lifecycle-testing-minimum-32-chars",
    );

    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      processedPages: number;
      nextContinuationToken: string | null;
      done: boolean;
      total: number;
      eligible: number;
      skipped: number;
      renewed: number;
      failed: number;
      failedKeys: { key: string; error: string }[];
    };
    expect(data.total).toBe(3);
    expect(data.eligible).toBe(2);
    expect(data.skipped).toBe(1);
    expect(data.renewed).toBe(1);
    expect(data.failed).toBe(1);
    expect(data.processedPages).toBe(2);
    expect(data.nextContinuationToken).toBeNull();
    expect(data.done).toBe(true);
    expect(data.failedKeys[0]?.key).toBe("fails.bin");
    expect(data.failedKeys[0]?.error).toContain("AccessDenied");

    const listCalls = mockS3Send.mock.calls.filter(
      (call) => commandName(call[0]) === "ListObjectsV2Command",
    );
    expect(listCalls.length).toBe(2);
    expect((listCalls[1][0] as MockCommand).input.ContinuationToken).toBe(
      "page-2-token",
    );
  });

  test("returns nextContinuationToken when maxPages limit is reached", async () => {
    mockS3Send = mock((command: MockCommand) => {
      if (commandName(command) === "HeadBucketCommand") {
        return Promise.resolve({});
      }
      if (commandName(command) === "ListObjectsV2Command") {
        if (!command.input.ContinuationToken) {
          return Promise.resolve({
            IsTruncated: true,
            NextContinuationToken: "next-page",
            Contents: [{ Key: "old-1.bin", LastModified: daysAgo(40) }],
          });
        }
        throw new Error("should only read one page when maxPages=1");
      }
      throw new Error(`unexpected command: ${commandName(command)}`);
    });

    const res = await post(
      "?dryRun=true&maxPages=1&maxKeys=42",
      "test-secret-token-for-lifecycle-testing-minimum-32-chars",
    );

    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      maxKeys: number;
      processedPages: number;
      nextContinuationToken: string | null;
      done: boolean;
      total: number;
      eligible: number;
    };
    expect(data.maxKeys).toBe(42);
    expect(data.processedPages).toBe(1);
    expect(data.nextContinuationToken).toBe("next-page");
    expect(data.done).toBe(false);
    expect(data.total).toBe(1);
    expect(data.eligible).toBe(1);

    const listCalls = mockS3Send.mock.calls.filter(
      (call) => commandName(call[0]) === "ListObjectsV2Command",
    );
    expect(listCalls.length).toBe(1);
    expect((listCalls[0][0] as MockCommand).input.MaxKeys).toBe(42);
  });

  test("starts listing from provided continuationToken", async () => {
    mockS3Send = mock((command: MockCommand) => {
      if (commandName(command) === "HeadBucketCommand") {
        return Promise.resolve({});
      }
      if (commandName(command) === "ListObjectsV2Command") {
        expect(command.input.ContinuationToken).toBe("resume-token");
        return Promise.resolve({
          IsTruncated: false,
          Contents: [{ Key: "old-2.bin", LastModified: daysAgo(40) }],
        });
      }
      throw new Error(`unexpected command: ${commandName(command)}`);
    });

    const res = await post(
      "?dryRun=true&continuationToken=resume-token",
      "test-secret-token-for-lifecycle-testing-minimum-32-chars",
    );

    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      processedPages: number;
      nextContinuationToken: string | null;
      done: boolean;
      total: number;
    };
    expect(data.processedPages).toBe(1);
    expect(data.nextContinuationToken).toBeNull();
    expect(data.done).toBe(true);
    expect(data.total).toBe(1);
  });

  test("returns 500 when bucket access check fails", async () => {
    mockS3Send = mock((command: MockCommand) => {
      if (commandName(command) === "HeadBucketCommand") {
        const error = new Error("bucket denied");
        error.name = "AccessDenied";
        return Promise.reject(error);
      }
      throw new Error(`unexpected command: ${commandName(command)}`);
    });

    const res = await post(
      "",
      "test-secret-token-for-lifecycle-testing-minimum-32-chars",
    );

    expect(res.status).toBe(500);
    const data = (await res.json()) as { error: string; details: string };
    expect(data.error).toContain("Timestamp migration failed");
    expect(data.details).toContain("bucket denied");
  });
});
