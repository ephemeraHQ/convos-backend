import { describe, expect, it, vi } from "vitest";
import { meGuard } from "@/api/v2/accounts/middleware/meGuard";

const makeReq = (accountId: string) =>
  ({ params: { accountId } } as any);

const makeRes = () => {
  const json = vi.fn();
  return { status: vi.fn(() => ({ json })), json } as any;
};

describe("meGuard", () => {
  it("calls next() for a valid UUID", () => {
    const req = makeReq("8f1c2e6d-1234-4abc-9def-0123456789ab");
    const res = makeRes();
    const next = vi.fn();
    meGuard(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it.each(["me", "Me", "ME", "mE", "MEME", "%6De", "not-a-uuid"])(
    "returns 400 invalid_account_id for %s",
    (val) => {
      const req = makeReq(val);
      const res = makeRes();
      const next = vi.fn();
      meGuard(req, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(400);
    },
  );
});
