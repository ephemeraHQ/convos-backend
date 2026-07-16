import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import cookieParser from "cookie-parser";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import v2Router from "@/api/v2";
import { globalJsonMiddleware } from "@/middleware/json";
import { pinoMiddleware } from "@/middleware/pino";
import { createJwtToken, validateJWTKeys } from "@/utils/jwt";
import { prisma } from "@/utils/prisma";

vi.mock("firebase-admin/app");
vi.mock("firebase-admin/app-check");
vi.mock("firebase-admin/messaging");

/**
 * Deletion-fence audit over the REAL /v2 router tree.
 *
 * The fence lives inside JWT authentication itself (enforceLiveAccountClaim
 * in src/middleware/auth.ts), so the structural guarantee is: every code
 * path that accepts a JWT runs the fence. Two layers of assertion:
 *
 * 1. Source audit — verifyJwtToken may only be called from the fenced
 *    middlewares' module. A new middleware that verifies JWTs anywhere else
 *    would bypass the fence and fails this test until it is either routed
 *    through the fenced middlewares or explicitly allowlisted with a fence
 *    of its own.
 * 2. Behavioral audit — the real production v2 router (not a synthetic
 *    mount) rejects a deleted account's unexpired JWT with the generic 401
 *    on every JWT surface and honors the single DELETE /v2/accounts/me
 *    carve-out.
 */

const makeRealApp = () => {
  const app = express();
  app.use(globalJsonMiddleware);
  app.use(cookieParser());
  app.use(pinoMiddleware);
  app.use("/api/v2", v2Router);
  return app;
};

/** Files allowed to call verifyJwtToken. */
const JWT_VERIFICATION_ALLOWLIST = new Set([
  "src/middleware/auth.ts", // fenced: enforceLiveAccountClaim
  "src/utils/jwt.ts", // the definition itself
]);

describe("deletion fence: source audit", () => {
  test("verifyJwtToken is only called from the fenced auth middlewares", () => {
    const repoRoot = path.resolve(__dirname, "../..");
    const stdout = execFileSync(
      "grep",
      ["-rln", "verifyJwtToken", "src", "--include=*.ts"],
      { cwd: repoRoot, encoding: "utf-8" },
    );
    const callers = stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const unfenced = callers.filter(
      (file) => !JWT_VERIFICATION_ALLOWLIST.has(file),
    );
    expect(
      unfenced,
      "These files verify JWTs outside the fenced middlewares — a deleted " +
        "account's token would not be fenced there. Route them through " +
        "authMiddleware/authMiddlewareAllowNSE or add an equivalent fence: " +
        unfenced.join(", "),
    ).toEqual([]);
  });
});

describe("deletion fence: real router behavior", () => {
  let deletedAccountToken: string;
  let deletedAccountId: string;

  beforeAll(async () => {
    await validateJWTKeys();
    const account = await prisma.account.create({ data: {} });
    deletedAccountId = account.id;
    deletedAccountToken = await createJwtToken({
      deviceId: "dev-fence-audit",
      accountId: account.id,
    });
    await prisma.account.delete({ where: { id: account.id } });
  });

  afterAll(async () => {
    await prisma.deletionRecord.deleteMany();
  });

  // Cover every JWT-authenticated surface previously found unfenced, plus one
  // representative per mounted subtree that carries authMiddleware. All must
  // return the generic 401.
  const jwtSurfaces: Array<{ method: "get" | "post" | "delete"; url: string }> =
    [
      { method: "get", url: "/api/v2/auth-check" },
      { method: "get", url: "/api/v2/account-auth-check" },
      { method: "post", url: "/api/v2/invite-codes/redeem" },
      { method: "get", url: "/api/v2/invite-codes/somecode/status" },
      { method: "get", url: "/api/v2/attachments/presigned" },
      { method: "get", url: "/api/v2/accounts/me/credits" },
      { method: "get", url: "/api/v2/accounts/me/subscription" },
      { method: "post", url: "/api/v2/accounts/me/subscription/verify" },
      { method: "post", url: "/api/v2/accounts/me/subscription/claim" },
      { method: "post", url: "/api/v2/agents/join" },
      { method: "get", url: "/api/v2/agents/join/some-instance" },
      { method: "post", url: "/api/v2/assets/renew-batch" },
      { method: "get", url: "/api/v2/connections" },
      { method: "post", url: "/api/v2/notifications/subscribe" },
    ];

  for (const surface of jwtSurfaces) {
    test(`${surface.method.toUpperCase()} ${surface.url} rejects a deleted account's unexpired JWT with a generic 401`, async () => {
      const app = makeRealApp();
      const res = await request(app)
        [surface.method](surface.url)
        .set("X-Convos-AuthToken", deletedAccountToken)
        .send({});
      expect(
        res.status,
        `expected 401, got ${res.status}: ${JSON.stringify(res.body)}`,
      ).toBe(401);
      expect(res.body).toEqual({ error: "Unauthorized" });
    });
  }

  test("the DELETE /v2/accounts/me carve-out still serves the stored deletion record", async () => {
    const operationId = randomUUID();
    // Simulate the committed deletion record the carve-out re-reads.
    const { hashAccountRef } =
      await import("@/accounts/deletion/identity-hash");
    const { setRuntimeConfig } = await import("@/utils/runtimeConfig");
    await setRuntimeConfig("account_deletion_enabled", "true");
    await prisma.deletionRecord.create({
      data: { operationId, accountRef: hashAccountRef(deletedAccountId) },
    });
    const res = await request(makeRealApp())
      .delete("/api/v2/accounts/me")
      .set("X-Convos-AuthToken", deletedAccountToken)
      .send({ operationId: randomUUID() });
    expect(
      res.status,
      `expected 200 replay, got ${res.status}: ${JSON.stringify(res.body)}`,
    ).toBe(200);
    expect((res.body as { operationId: string }).operationId).toBe(operationId);
  });

  test("a live account's JWT still passes the fence (no false 401)", async () => {
    const account = await prisma.account.create({ data: {} });
    const token = await createJwtToken({
      deviceId: "dev-fence-live",
      accountId: account.id,
    });
    const res = await request(makeRealApp())
      .get("/api/v2/auth-check")
      .set("X-Convos-AuthToken", token);
    expect(res.status).toBe(200);
    await prisma.account.delete({ where: { id: account.id } });
  });
});
