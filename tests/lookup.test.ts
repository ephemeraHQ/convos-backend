import type { Server } from "http";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import express from "express";
import lookupRouter, { type LookupResponse } from "@/api/v1/lookup";
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
   * Test for the address lookup endpoint
   * Using a known address that has social profiles
   */
  test("GET /lookup/address/:address returns social profiles", async () => {
    const testAddress = "0x1234567890123456789012345678901234567890";
    const response = await fetch(
      `http://localhost:3006/lookup/address/${testAddress}`,
    );
    const data = (await response.json()) as LookupResponse;

    expect(response.status).toBe(200);
    expect(data.socialProfiles).toEqual([]);
  });

  test("GET /lookup/address/:address returns Vitalik's ENS social profiles", async () => {
    const vitalikAddress = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
    const response = await fetch(
      `http://localhost:3006/lookup/address/${vitalikAddress}`,
    );
    const data = (await response.json()) as LookupResponse;

    expect(response.status).toBe(200);
    expect(data.socialProfiles).toEqual([
      {
        type: "ens",
        address: vitalikAddress,
        name: "vitalik.eth",
      },
    ]);
  });
});
