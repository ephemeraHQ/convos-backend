import { describe, expect, test } from "bun:test";
import cookieParser from "cookie-parser";
import express from "express";
import request from "supertest";

describe("cookie-parser wiring smoke", () => {
  test("server reads cookies from Cookie header", async () => {
    const app = express();
    app.use(cookieParser());
    app.get("/echo", (req, res) => {
      res.json({ cookies: req.cookies as Record<string, string> });
    });

    const res = await request(app).get("/echo").set("Cookie", "x=hello");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ cookies: { x: "hello" } });
  });
});
