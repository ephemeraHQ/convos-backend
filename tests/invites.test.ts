import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import express from "express";
import invitesV2Router from "@/api/v2/invites/invites.router";
import { jsonMiddleware } from "@/middleware/json";
import { pinoMiddleware } from "@/middleware/pino";
import { prisma } from "@/utils/prisma";

const app = express();
app.use(pinoMiddleware);
app.use(jsonMiddleware);
app.use("/api/v2/invites", invitesV2Router);

describe("Invites API Tests", () => {
  let server: Server;
  const baseURL = "http://localhost:4001";

  beforeAll(async () => {
    await new Promise<void>((resolve) => {
      server = app.listen(4001, () => {
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

  describe("GET /api/v2/invites/:slug", () => {
    test("should return 404 for missing slug", async () => {
      const response = await fetch(`${baseURL}/api/v2/invites/`, {
        method: "GET",
      });

      expect(response.status).toBe(404);
    });

    test("should return 400 for invalid base64 slug", async () => {
      const response = await fetch(`${baseURL}/api/v2/invites/invalid!!!`, {
        method: "GET",
      });

      expect(response.status).toBe(400);
      const data = (await response.json()) as {
        success: boolean;
        error: string;
      };
      expect(data.success).toBe(false);
      expect(data.error).toBe("INVALID_INVITE");
    });

    test("should return 400 for malformed protobuf", async () => {
      const invalidProtobuf = Buffer.from("not a valid protobuf").toString(
        "base64url",
      );
      const response = await fetch(
        `${baseURL}/api/v2/invites/${invalidProtobuf}`,
        {
          method: "GET",
        },
      );

      expect(response.status).toBe(400);
      const data = (await response.json()) as {
        success: boolean;
        error: string;
      };
      expect(data.success).toBe(false);
      expect(data.error).toBe("INVALID_INVITE");
    });

    test("should reject slugs that are too large (DoS protection)", async () => {
      const hugSlug = "A".repeat(2050);
      const response = await fetch(`${baseURL}/api/v2/invites/${hugSlug}`, {
        method: "GET",
      });

      // Handler rejects with 413 (Payload Too Large) for slugs over 2048 chars
      expect(response.status).toBe(413);
    });

    test("should return valid structure with null fields for valid old-format invite", async () => {
      // Pre-generated valid SignedInvite slug
      // Contains: conversationId, inviteId, signature; no name/description/imageURL
      const validSlug =
        "CqQBClRBZjBJY3ZNSmo5TW9UcFZEc2x0YnNSakNwaldvcTA2am9iYmRWcVRZb2l4RUQzNVN1X1BJWmNaRmN0MkM5eDFqdEQydE4wZXM0Tkx4MDZMRkJhS3USQDYyZTFmMDIwNTc4YmRjNjMxMDZkZTJmYmFkODUzMzVjM2VkYzRhNzlhNWIyMWVhNjgxMjE2OGQxZjY3MTNlMjUaClVhN2RSRlFqdmESQcEhHVsmCTay20THnnQlEUDVGfhG9OnyHqgbtTFa9WBFat7aUl_22_SPdWfKSZuFUw3N90jc2vtWHkr2zb8eNrEB";

      const response = await fetch(`${baseURL}/api/v2/invites/${validSlug}`, {
        method: "GET",
      });

      expect(response.status).toBe(200);
      const data = (await response.json()) as {
        success: boolean;
        data: {
          name: string | null;
          description: string | null;
          imageURL: string | null;
          conversationExpiresAt: string | null;
          expiresAt: string | null;
          expiresAfterUse: boolean;
        };
      };
      expect(data.success).toBe(true);
      expect(data.data).toBeDefined();
      expect(data.data).toHaveProperty("name");
      expect(data.data).toHaveProperty("description");
      expect(data.data).toHaveProperty("imageURL");
      expect(data.data).toHaveProperty("conversationExpiresAt");
      expect(data.data).toHaveProperty("expiresAt");
      expect(data.data).toHaveProperty("expiresAfterUse");
      expect(data.data.name).toBeNull();
      expect(data.data.description).toBeNull();
      expect(data.data.imageURL).toBeNull();
      expect(data.data.conversationExpiresAt).toBeNull();
      expect(data.data.expiresAt).toBeNull();
      expect(data.data.expiresAfterUse).toBe(false);
    });

    test("should decode compressed invite slug from iOS", async () => {
      // iOS app compresses invites using raw DEFLATE with a 5-byte header:
      // [0x1F marker][4-byte BE original size][compressed data]
      const compressedSlug =
        "HwAAAb4lj09IVFEUxplJ0GZhZK2m0Q5GECkjuNEYRJxJZEiISInJ1Z13D3bk3Xuf7947DGqrWoiJBTqDSbRw4ywCN7Xq36KFDLYRJYSgP0QFLhQJI3DjnWZ3Duc7v-_7Yv-isf5I_Nyr1p-5_KW95pdH0YuRjStr60MNnztyc21vl-JdD6eL2cTdppWxaHT5y7vHZ3ZkqXzt68LZbOOj131_5ystUK2O_Dm1mHt_79NBZb9ns-Pj7evF84dvvMaJrfRaYW82HqOsSN8IM5l0sb01o2RBaRhBbSCjRBCi1sgh*Kwtk8OrvyLAKUQAF2grgylchaDLABJpO8JTU6Bk0NgTGKSDtkRwH9MkdaxSuAMlqoTgYFIF7JukRJ26lAWvAZ3mHBzR1NIJg45IB82nSsiSMGkBJwrFBUG0ouJWJTpi0pEEqbULLAYsYemSYISXB-j4TnqqTayLSVHP6j6TAiQGZCy5cJlUv4KxMsmVg9XR19cLcrxLHXUhsv3iQenq_3y7dHPwGz55M5S-33-re-t5bGUssHt-Z_bGb-tB14KdWSs-DzaTqLrOZcuQE";

      const response = await fetch(
        `${baseURL}/api/v2/invites/${compressedSlug}`,
        {
          method: "GET",
        },
      );

      expect(response.status).toBe(200);
      const data = (await response.json()) as {
        success: boolean;
        data: {
          name: string | null;
          description: string | null;
          imageURL: string | null;
          conversationExpiresAt: string | null;
          expiresAt: string | null;
          expiresAfterUse: boolean;
        };
      };
      expect(data.success).toBe(true);
      expect(data.data).toBeDefined();
    });

    test("should reject decompression bombs (oversized originalSize)", async () => {
      // Create payload with 0x1F marker + huge size (1GB) + minimal data
      const marker = Buffer.from([0x1f]);
      const hugeSize = Buffer.from([0x40, 0x00, 0x00, 0x00]); // 1GB in big-endian
      const minimalData = Buffer.from([0x00]);
      const maliciousPayload = Buffer.concat([marker, hugeSize, minimalData]);
      const slug = maliciousPayload.toString("base64url");

      const response = await fetch(`${baseURL}/api/v2/invites/${slug}`, {
        method: "GET",
      });

      expect(response.status).toBe(400);
      const data = (await response.json()) as { success: boolean };
      expect(data.success).toBe(false);
    });
  });

  describe("Response format validation", () => {
    test("should return consistent error format", async () => {
      const response = await fetch(`${baseURL}/api/v2/invites/invalid`, {
        method: "GET",
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
      const response = await fetch(`${baseURL}/api/v2/invites/invalid`, {
        method: "GET",
      });

      const data = (await response.json()) as { message: string };
      expect(data.message).not.toContain("stack");
      expect(data.message).not.toContain("Error:");
      expect(JSON.stringify(data)).not.toContain("prisma");
    });

    test("should handle special characters in slug safely", async () => {
      const specialChars = "../../../etc/passwd";
      const response = await fetch(
        `${baseURL}/api/v2/invites/${encodeURIComponent(specialChars)}`,
        {
          method: "GET",
        },
      );

      expect(response.status).toBe(400);
      const data = (await response.json()) as { success: boolean };
      expect(data.success).toBe(false);
    });
  });
});
