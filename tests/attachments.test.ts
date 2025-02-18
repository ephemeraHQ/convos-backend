import crypto from "crypto";
import type { Server } from "http";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import express from "express";
import attachmentsRouter from "@/api/v1/attachments";
import { jsonMiddleware } from "@/middleware/json";

const app = express();
app.use(jsonMiddleware);
app.use("/attachments", attachmentsRouter);

let server: Server;

beforeAll(() => {
  // start the server on a test port
  server = app.listen(3007);
});

afterAll(() => {
  // close the server
  server.close();
});

// Helper function to calculate file hash
const calculateHash = (buffer: ArrayBuffer) => {
  const hash = crypto.createHash("sha256");
  hash.update(Buffer.from(buffer));
  return hash.digest("hex");
};

describe("/attachments API", () => {
  /**
   * Integration tests that perform live operations with S3.
   * These tests are skipped by default as they:
   * 1. Require valid S3 credentials in the environment
   * 2. Make actual network requests to S3
   * 3. Create and store real files in the S3 bucket
   *
   * To run these tests, remove the .skip from the describe block
   */
  describe.skip("integration tests", () => {
    test("uploads and validates text file content", async () => {
      // Get presigned URL
      const response = await fetch(
        "http://localhost:3007/attachments/presigned?contentType=text/plain",
      );
      expect(response.status).toBe(200);
      const data = (await response.json()) as {
        url: string;
        objectKey: string;
      };
      expect(data.url).toBeDefined();
      expect(data.objectKey).toBeDefined();

      // Create a test file content
      const testContent = "Hello, this is a test file!";
      const blob = new Blob([testContent], { type: "text/plain" });

      // Upload the file using the presigned URL
      const uploadResponse = await fetch(data.url, {
        method: "PUT",
        body: blob,
        headers: {
          "Content-Type": "text/plain",
          "x-amz-acl": "public-read",
        },
      });
      expect(uploadResponse.status).toBe(200);

      // Extract the public URL from the presigned URL
      const fileURL = new URL(data.url);
      const publicURL = fileURL.origin + fileURL.pathname;

      // Download and verify the file content
      const downloadResponse = await fetch(publicURL);
      expect(downloadResponse.status).toBe(200);
      const downloadedContent = await downloadResponse.text();
      expect(downloadedContent).toBe(testContent);
    });

    test("uploads and validates image content", async () => {
      // Create a test image (1x1 pixel PNG)
      const pngImageBytes = new Uint8Array([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
        0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
        0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
        0x0d, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0x60, 0x60, 0x60, 0x60,
        0x00, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00,
        0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
      ]);

      // Get presigned URL for PNG
      const response = await fetch(
        "http://localhost:3007/attachments/presigned?contentType=image/png",
      );
      expect(response.status).toBe(200);
      const data = (await response.json()) as {
        url: string;
        objectKey: string;
      };

      // Calculate original image hash
      const originalHash = calculateHash(pngImageBytes.buffer);

      // Upload the image
      const uploadResponse = await fetch(data.url, {
        method: "PUT",
        body: pngImageBytes,
        headers: {
          "Content-Type": "image/png",
          "x-amz-acl": "public-read",
        },
      });
      expect(uploadResponse.status).toBe(200);

      // Get public URL and download the image
      const fileURL = new URL(data.url);
      const publicURL = fileURL.origin + fileURL.pathname;
      const downloadResponse = await fetch(publicURL);
      expect(downloadResponse.status).toBe(200);

      // Get the downloaded image as ArrayBuffer and calculate its hash
      const downloadedBuffer = await downloadResponse.arrayBuffer();
      const downloadedHash = calculateHash(downloadedBuffer);

      // Compare hashes to verify the image is identical
      expect(downloadedHash).toBe(originalHash);
    });
  });
});
