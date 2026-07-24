import { Prisma } from "@prisma/client";
import { describe, expect, test } from "vitest";
import { isSerializationFailure } from "@/api/v2/agent-templates/handlers/featured-order";

// A concurrent write against the gallery is an EXPECTED outcome of the order
// endpoint's SERIALIZABLE transaction — it must answer 409 ("re-read and try
// again"), never 500. Which Prisma error carries that depends on the query
// style, and the transaction mixes both: Prisma maps its own queries to P2034,
// while a raw query surfaces the driver's 40001 wrapped as P2010. Matching only
// the first is exactly the bug this pins — it let a real conflict escape as a
// 500 whenever the race actually landed.
const prismaError = (code: string, meta?: Record<string, unknown>) =>
  new Prisma.PrismaClientKnownRequestError("boom", {
    code,
    clientVersion: "test",
    meta,
  });

describe("featured-order — serialization failures", () => {
  test("Prisma's own serialization code counts", () => {
    expect(isSerializationFailure(prismaError("P2034"))).toBe(true);
  });

  test("a raw query's 40001 counts, wrapped as P2010", () => {
    expect(
      isSerializationFailure(
        prismaError("P2010", {
          code: "40001",
          message: "could not serialize access due to concurrent update",
        }),
      ),
    ).toBe(true);
  });

  test("another raw failure is not a serialization failure", () => {
    // A genuine query bug must still surface as a 500, not be laundered into a
    // 409 that tells the operator to try again.
    expect(
      isSerializationFailure(
        prismaError("P2010", { code: "42P01", message: "relation missing" }),
      ),
    ).toBe(false);
  });

  test("unrelated errors are not serialization failures", () => {
    expect(isSerializationFailure(prismaError("P2025"))).toBe(false);
    expect(isSerializationFailure(new Error("nope"))).toBe(false);
    expect(isSerializationFailure(undefined)).toBe(false);
  });
});
