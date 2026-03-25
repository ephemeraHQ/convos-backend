import type { Server } from "node:http";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import express from "express";
import { inviteCodesRouter } from "@/api/v2/invite-codes/invite-codes.router";
import { jsonMiddleware } from "@/middleware/json";
import { pinoMiddleware } from "@/middleware/pino";
import { prisma } from "@/utils/prisma";

// Minimal test app — skip full JWT auth for unit testing the handler logic.
// Auth is tested separately in jwt.test.ts; here we focus on the code
// redemption business logic.
const app = express();
app.use(pinoMiddleware);
app.use(jsonMiddleware);
app.use("/api/v2/invite-codes", inviteCodesRouter);

describe("Invite Codes API Tests", () => {
  let server: Server;
  const baseURL = "http://localhost:4002";

  beforeAll(async () => {
    await new Promise<void>((resolve) => {
      server = app.listen(4002, () => {
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
    await prisma.$disconnect();
  });

  afterEach(async () => {
    // Clean up test codes between tests
    await prisma.inviteCode.deleteMany({
      where: { batchLabel: "test" },
    });
  });

  describe("POST /api/v2/invite-codes/redeem", () => {
    test("should return 422 for missing code in body", async () => {
      const response = await fetch(`${baseURL}/api/v2/invite-codes/redeem`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      expect(response.status).toBe(422);
      const data = (await response.json()) as {
        success: boolean;
        error: string;
      };
      expect(data.success).toBe(false);
      expect(data.error).toBe("CODE_INVALID_FORMAT");
    });

    test("should return 422 for malformed code (too short)", async () => {
      const response = await fetch(`${baseURL}/api/v2/invite-codes/redeem`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: "ABC" }),
      });

      expect(response.status).toBe(422);
      const data = (await response.json()) as {
        success: boolean;
        error: string;
      };
      expect(data.success).toBe(false);
      expect(data.error).toBe("CODE_INVALID_FORMAT");
    });

    test("should return 422 for code with ambiguous characters (O, I)", async () => {
      const response = await fetch(`${baseURL}/api/v2/invite-codes/redeem`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: "ABCDEFOI" }),
      });

      expect(response.status).toBe(422);
      const data = (await response.json()) as {
        success: boolean;
        error: string;
      };
      expect(data.success).toBe(false);
      expect(data.error).toBe("CODE_INVALID_FORMAT");
    });

    test("should return 422 for code with numbers", async () => {
      const response = await fetch(`${baseURL}/api/v2/invite-codes/redeem`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: "ABCD1234" }),
      });

      expect(response.status).toBe(422);
      const data = (await response.json()) as {
        success: boolean;
        error: string;
      };
      expect(data.success).toBe(false);
      expect(data.error).toBe("CODE_INVALID_FORMAT");
    });

    test("should return 404 for code that does not exist", async () => {
      const response = await fetch(`${baseURL}/api/v2/invite-codes/redeem`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: "XKQBWFMR" }),
      });

      expect(response.status).toBe(404);
      const data = (await response.json()) as {
        success: boolean;
        error: string;
      };
      expect(data.success).toBe(false);
      expect(data.error).toBe("CODE_NOT_FOUND");
    });

    test("should return 200 for valid unredeemed code", async () => {
      // Seed a code
      await prisma.inviteCode.create({
        data: { code: "XKQBWFMR", batchLabel: "test" },
      });

      const response = await fetch(`${baseURL}/api/v2/invite-codes/redeem`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: "XKQBWFMR" }),
      });

      expect(response.status).toBe(200);
      const data = (await response.json()) as { success: boolean };
      expect(data.success).toBe(true);

      // Verify the code was marked as redeemed
      const updated = await prisma.inviteCode.findUnique({
        where: { code: "XKQBWFMR" },
      });
      expect(updated?.redeemedAt).not.toBeNull();
    });

    test("should return 409 for already redeemed code", async () => {
      // Seed a redeemed code
      await prisma.inviteCode.create({
        data: {
          code: "ALRDYUSD",
          batchLabel: "test",
          redeemedAt: new Date(),
        },
      });

      const response = await fetch(`${baseURL}/api/v2/invite-codes/redeem`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: "ALRDYUSD" }),
      });

      expect(response.status).toBe(409);
      const data = (await response.json()) as {
        success: boolean;
        error: string;
      };
      expect(data.success).toBe(false);
      expect(data.error).toBe("CODE_ALREADY_REDEEMED");
    });

    test("should normalise lowercase input to uppercase", async () => {
      await prisma.inviteCode.create({
        data: { code: "LWRCSETX", batchLabel: "test" },
      });

      const response = await fetch(`${baseURL}/api/v2/invite-codes/redeem`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: "lwrcsetx" }),
      });

      expect(response.status).toBe(200);
      const data = (await response.json()) as { success: boolean };
      expect(data.success).toBe(true);
    });

    test("should return consistent error format", async () => {
      const response = await fetch(`${baseURL}/api/v2/invite-codes/redeem`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: "NOTFOUND" }),
      });

      const data = (await response.json()) as {
        success: boolean;
        error: string;
        message: string;
      };
      expect(data).toHaveProperty("success");
      expect(data).toHaveProperty("error");
      expect(data).toHaveProperty("message");
      expect(data.success).toBe(false);
      expect(typeof data.error).toBe("string");
      expect(typeof data.message).toBe("string");
    });
  });

  describe("Security tests", () => {
    test("should not expose internal error details", async () => {
      const response = await fetch(`${baseURL}/api/v2/invite-codes/redeem`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: "NOTFOUND" }),
      });

      const data = (await response.json()) as { message: string };
      expect(data.message).not.toContain("stack");
      expect(data.message).not.toContain("Error:");
      expect(JSON.stringify(data)).not.toContain("prisma");
    });
  });
});
