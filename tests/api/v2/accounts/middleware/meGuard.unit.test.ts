import type { NextFunction, Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";
import { meGuard } from "@/api/v2/accounts/middleware/meGuard";

const makeReq = (accountId: string): Request =>
  ({ params: { accountId } }) as unknown as Request;

const makeRes = () => {
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  return {
    res: { status, json } as unknown as Response,
    status,
  };
};

describe("meGuard", () => {
  it("calls next() for a valid UUID", () => {
    const req = makeReq("8f1c2e6d-1234-4abc-9def-0123456789ab");
    const { res, status } = makeRes();
    const next: NextFunction = vi.fn();
    meGuard(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(status).not.toHaveBeenCalled();
  });

  it.each(["me", "Me", "ME", "mE", "MEME", "%6De", "not-a-uuid"])(
    "returns 400 invalid_account_id for %s",
    (val) => {
      const req = makeReq(val);
      const { res, status } = makeRes();
      const next: NextFunction = vi.fn();
      meGuard(req, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(status).toHaveBeenCalledWith(400);
    },
  );
});
