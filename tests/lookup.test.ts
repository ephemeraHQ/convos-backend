import type { Server } from "http";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import express from "express";
import lookupRouter from "@/api/v1/lookup";
import { jsonMiddleware } from "@/middleware/json";

const app = express();
app.use(jsonMiddleware);
app.use("/lookup", lookupRouter);

let server: Server;

beforeAll(() => {
  // start the server on a test port
  server = app.listen(3006);
});

afterAll(() => {
  // close the server
  server.close();
});

describe("/lookup API", () => {
  /**
   * Only uncomment this test when you want to test the actual lookup
   * on an address.
   */
  // test("GET /lookup/address/:address returns social profiles", async () => {
  //   const michaellustigcbidaddress = "0x0aF89d2778f6ccE4A2641438B6207DC4750a82B";
  //   const shaneaddress = "0xa64af7f78de39a238ecd4fff7d6d410dbace2df0";
  //   const response = await fetch(
  //     `http://localhost:3006/lookup/address/${shaneaddress}`,
  //   );
  //   const data = await response.json();

  //   expect(response.status).toBe(200);
  //   expect(data).toBeDefined();
  // });

  test("GET /lookup/address/:address returns 500 when THIRDWEB_SECRET_KEY is not set", async () => {
    // Remove environment variable
    delete process.env.THIRDWEB_SECRET_KEY;

    const response = await fetch(
      "http://localhost:3006/lookup/address/0x123456789",
    );
    const data = (await response.json()) as { error: string };

    expect(response.status).toBe(500);
    expect(data.error).toBe("Failed to lookup address");
  });
});
