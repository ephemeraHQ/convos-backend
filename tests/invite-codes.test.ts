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
    // Delete redemptions first (FK constraint)
    await prisma.inviteCodeRedemption.deleteMany({
      where: {
        inviteCode: { batchLabel: "test" },
      },
    });
    // Delete child codes (codes with a parent that has batchLabel "test")
    await prisma.inviteCode.deleteMany({
      where: {
        parentCode: { batchLabel: "test" },
      },
    });
    // Delete parent codes
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

    test("should return 200 for valid unredeemed code and generate child code", async () => {
      // Seed a code with maxRedemptions = 1
      await prisma.inviteCode.create({
        data: { code: "XKQBWFMR", batchLabel: "test", maxRedemptions: 1 },
      });

      const response = await fetch(`${baseURL}/api/v2/invite-codes/redeem`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: "XKQBWFMR" }),
      });

      expect(response.status).toBe(200);
      const data = (await response.json()) as {
        success: boolean;
        data: {
          inviteCode: {
            code: string;
            name: string | null;
            maxRedemptions: number;
            redemptionCount: number;
            remainingRedemptions: number;
          };
        };
      };
      expect(data.success).toBe(true);

      // Should return a child invite code
      expect(data.data.inviteCode).toBeDefined();
      expect(data.data.inviteCode.code).toHaveLength(8);
      expect(data.data.inviteCode.maxRedemptions).toBe(5); // default child max
      expect(data.data.inviteCode.redemptionCount).toBe(0);
      expect(data.data.inviteCode.remainingRedemptions).toBe(5);

      // Verify the parent code was marked as redeemed
      const updated = await prisma.inviteCode.findUnique({
        where: { code: "XKQBWFMR" },
      });
      if (!updated) throw new Error("Expected parent invite code to exist");
      expect(updated.redemptionCount).toBe(1);
      expect(updated.redeemedAt).not.toBeNull();

      // Verify the child code exists in DB
      const childCode = await prisma.inviteCode.findUnique({
        where: { code: data.data.inviteCode.code },
      });
      if (!childCode) throw new Error("Expected child invite code to exist");
      expect(childCode.parentCodeId).toBe(updated.id);
      expect(childCode.maxRedemptions).toBe(5);

      // Verify the redemption record was created
      const redemptions = await prisma.inviteCodeRedemption.findMany({
        where: { inviteCodeId: updated.id },
      });
      expect(redemptions).toHaveLength(1);
      expect(redemptions[0].childCodeId).toBe(childCode.id);
    });

    test("should return 409 for fully redeemed single-use code", async () => {
      // Seed a code that's already been redeemed
      await prisma.inviteCode.create({
        data: {
          code: "ALRDYUSD",
          batchLabel: "test",
          maxRedemptions: 1,
          redemptionCount: 1,
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
      // Backwards-compatible error code
      expect(data.error).toBe("CODE_ALREADY_REDEEMED");
    });

    test("should allow multi-use code to be redeemed multiple times", async () => {
      // Seed a code with maxRedemptions = 3
      await prisma.inviteCode.create({
        data: { code: "MLTUSETX", batchLabel: "test", maxRedemptions: 3 },
      });

      // First redemption
      const res1 = await fetch(`${baseURL}/api/v2/invite-codes/redeem`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: "MLTUSETX" }),
      });
      expect(res1.status).toBe(200);
      const data1 = (await res1.json()) as {
        success: boolean;
        data: { inviteCode: { code: string } };
      };
      expect(data1.success).toBe(true);

      // Second redemption
      const res2 = await fetch(`${baseURL}/api/v2/invite-codes/redeem`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: "MLTUSETX" }),
      });
      expect(res2.status).toBe(200);
      const data2 = (await res2.json()) as {
        success: boolean;
        data: { inviteCode: { code: string } };
      };
      expect(data2.success).toBe(true);

      // Each redemption should produce a different child code
      expect(data1.data.inviteCode.code).not.toBe(data2.data.inviteCode.code);

      // Third redemption
      const res3 = await fetch(`${baseURL}/api/v2/invite-codes/redeem`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: "MLTUSETX" }),
      });
      expect(res3.status).toBe(200);

      // Fourth redemption should fail — max reached
      const res4 = await fetch(`${baseURL}/api/v2/invite-codes/redeem`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: "MLTUSETX" }),
      });
      expect(res4.status).toBe(409);
      const data4 = (await res4.json()) as { error: string };
      expect(data4.error).toBe("CODE_ALREADY_REDEEMED");

      // Verify the redemption count
      const code = await prisma.inviteCode.findUnique({
        where: { code: "MLTUSETX" },
      });
      expect(code?.redemptionCount).toBe(3);
      expect(code?.maxRedemptions).toBe(3);

      // Verify redemption records
      const redemptions = await prisma.inviteCodeRedemption.findMany({
        where: { inviteCodeId: code!.id },
        orderBy: { redeemedAt: "asc" },
      });
      expect(redemptions).toHaveLength(3);
    });

    test("should normalise lowercase input to uppercase", async () => {
      await prisma.inviteCode.create({
        data: { code: "LWRCSETX", batchLabel: "test", maxRedemptions: 1 },
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

  describe("GET /api/v2/invite-codes/:code/status", () => {
    test("should return status for an available code", async () => {
      await prisma.inviteCode.create({
        data: {
          code: "STATUSTX",
          batchLabel: "test",
          name: "Test Code",
          maxRedemptions: 10,
          redemptionCount: 3,
        },
      });

      const response = await fetch(
        `${baseURL}/api/v2/invite-codes/STATUSTX/status`,
      );

      expect(response.status).toBe(200);
      const data = (await response.json()) as {
        success: boolean;
        data: {
          code: string;
          name: string;
          maxRedemptions: number;
          redemptionCount: number;
          remainingRedemptions: number;
        };
      };
      expect(data.success).toBe(true);
      expect(data.data.code).toBe("STATUSTX");
      expect(data.data.name).toBe("Test Code");
      expect(data.data.maxRedemptions).toBe(10);
      expect(data.data.redemptionCount).toBe(3);
      expect(data.data.remainingRedemptions).toBe(7);
    });

    test("should return status for a fully redeemed code", async () => {
      await prisma.inviteCode.create({
        data: {
          code: "FULLRDMD",
          batchLabel: "test",
          maxRedemptions: 2,
          redemptionCount: 2,
          redeemedAt: new Date(),
        },
      });

      const response = await fetch(
        `${baseURL}/api/v2/invite-codes/FULLRDMD/status`,
      );

      expect(response.status).toBe(200);
      const data = (await response.json()) as {
        success: boolean;
        data: {
          remainingRedemptions: number;
        };
      };
      expect(data.success).toBe(true);
      expect(data.data.remainingRedemptions).toBe(0);
    });

    test("should return 404 for non-existent code", async () => {
      const response = await fetch(
        `${baseURL}/api/v2/invite-codes/NTFNDXYZ/status`,
      );

      expect(response.status).toBe(404);
      const data = (await response.json()) as { error: string };
      expect(data.error).toBe("CODE_NOT_FOUND");
    });

    test("should return 422 for invalid code format", async () => {
      const response = await fetch(`${baseURL}/api/v2/invite-codes/bad/status`);

      expect(response.status).toBe(422);
      const data = (await response.json()) as { error: string };
      expect(data.error).toBe("CODE_INVALID_FORMAT");
    });

    test("should normalise lowercase code to uppercase", async () => {
      await prisma.inviteCode.create({
        data: {
          code: "LWRSTATS",
          batchLabel: "test",
          maxRedemptions: 5,
        },
      });

      const response = await fetch(
        `${baseURL}/api/v2/invite-codes/lwrstats/status`,
      );

      expect(response.status).toBe(200);
      const data = (await response.json()) as {
        success: boolean;
        data: { code: string };
      };
      expect(data.success).toBe(true);
      expect(data.data.code).toBe("LWRSTATS");
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
