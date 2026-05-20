import { afterEach, describe, expect, test } from "bun:test";
import type { NextFunction, Request, Response } from "express";
import {
  __setCronApiKeyOverrideForTests,
  requireCronApiKey,
} from "@/api/v2/credits/middleware/cron-api-key";

const TEST_KEY = "test-cron-api-key-that-is-at-least-32-characters-long";

function mockRes() {
  const headers: Record<string, unknown> = {};
  const body: { json?: unknown; status?: number } = {};
  const res = {
    status(code: number) {
      body.status = code;
      return this;
    },
    json(obj: unknown) {
      body.json = obj;
      return this;
    },
    headers,
    body,
  } as unknown as Response & { body: typeof body };
  return res;
}

function mockReq(headerVal?: string) {
  return {
    headers: headerVal ? { "x-cron-api-key": headerVal } : {},
    log: {
      info() {},
      warn() {},
      error() {},
    },
  } as unknown as Request;
}

afterEach(() => {
  __setCronApiKeyOverrideForTests(undefined);
});

describe("requireCronApiKey", () => {
  test("missing header → 401", () => {
    __setCronApiKeyOverrideForTests(TEST_KEY);
    const req = mockReq();
    const res = mockRes();
    let nextCalled = false;
    requireCronApiKey(req, res, (() => {
      nextCalled = true;
    }) as NextFunction);
    expect(nextCalled).toBe(false);
    expect(res.body.status).toBe(401);
  });

  test("wrong header → 401", () => {
    __setCronApiKeyOverrideForTests(TEST_KEY);
    const req = mockReq("wrong-key");
    const res = mockRes();
    let nextCalled = false;
    requireCronApiKey(req, res, (() => {
      nextCalled = true;
    }) as NextFunction);
    expect(nextCalled).toBe(false);
    expect(res.body.status).toBe(401);
  });

  test("correct header → next()", () => {
    __setCronApiKeyOverrideForTests(TEST_KEY);
    const req = mockReq(TEST_KEY);
    const res = mockRes();
    let nextCalled = false;
    requireCronApiKey(req, res, (() => {
      nextCalled = true;
    }) as NextFunction);
    expect(nextCalled).toBe(true);
  });

  test("unset cron key → 503", () => {
    __setCronApiKeyOverrideForTests(null);
    const req = mockReq("anything");
    const res = mockRes();
    requireCronApiKey(req, res, (() => {}) as NextFunction);
    expect(res.body.status).toBe(503);
  });
});
