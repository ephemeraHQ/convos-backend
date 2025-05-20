import type { Server } from "http";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import express from "express";
import { rimrafSync } from "rimraf";
import { AUTH_HEADER, authMiddleware } from "@/middleware/auth";
import { createClient, createJWT } from "./helpers";

// mock environment variable
process.env.JWT_SECRET = "test-jwt-secret";

const app = express();
app.use(authMiddleware);
app.get("/test", (req, res) => {
  res.status(200).send("OK");
});

let server: Server;

beforeAll(() => {
  server = app.listen(3007);
});

afterAll(() => {
  server.close();
  // clean up the test databases
  rimrafSync("tests/**/*.db3*", { glob: true });
});

describe("authMiddleware", () => {
  test("allows request with a valid auth token", async () => {
    const client = await createClient();
    const response = await fetch("http://localhost:3007/test", {
      headers: {
        [AUTH_HEADER]: await createJWT(client, process.env.JWT_SECRET!),
      },
    });

    expect(response.status).toBe(200);
  });

  test("responds 401 when request is missing auth header", async () => {
    const response = await fetch("http://localhost:3007/test");

    expect(response.status).toBe(401);
  });

  test("responds 401 when request has invalid auth token", async () => {
    const client = await createClient();
    const response = await fetch("http://localhost:3007/test", {
      headers: {
        [AUTH_HEADER]: await createJWT(client, "invalid-secret"),
      },
    });

    expect(response.status).toBe(401);
  });
});
