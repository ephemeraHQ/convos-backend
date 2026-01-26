import {
  CopyObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";

const envSchema = z.object({
  LIFECYCLE_TEST_BUCKET: z.string().optional(),
});

const env = envSchema.parse({
  LIFECYCLE_TEST_BUCKET: process.env.LIFECYCLE_TEST_BUCKET,
});

const s3Client = env.LIFECYCLE_TEST_BUCKET ? new S3Client({}) : null;

/**
 * POST /v2/assets/test/lifecycle
 *
 * Dev-only endpoint to validate the copy-to-self lifecycle renewal mechanism.
 *
 * 1. Uploads a test object to LIFECYCLE_TEST_BUCKET
 * 2. Gets its LastModified timestamp
 * 3. Performs copy-to-self (simulates renewal)
 * 4. Gets the new LastModified timestamp
 * 5. Optionally cleans up the test object
 * 6. Returns both timestamps to prove it works
 */
export async function testLifecycleHandler(req: Request, res: Response) {
  if (!env.LIFECYCLE_TEST_BUCKET || !s3Client) {
    res.status(503).json({
      error:
        "Lifecycle test not available - LIFECYCLE_TEST_BUCKET not configured",
    });
    return;
  }

  const cleanup = req.query.cleanup !== "false"; // Default: cleanup after test
  const testKey = `lifecycle-test-${uuidv4()}.txt`;
  const testContent = `Test object created at ${new Date().toISOString()}`;

  try {
    req.log.info({ testKey }, "Starting lifecycle test");

    // Step 1: Upload test object
    await s3Client.send(
      new PutObjectCommand({
        Bucket: env.LIFECYCLE_TEST_BUCKET,
        Key: testKey,
        Body: testContent,
        ContentType: "text/plain",
      }),
    );

    // Step 2: Get initial LastModified
    const initialHead = await s3Client.send(
      new HeadObjectCommand({
        Bucket: env.LIFECYCLE_TEST_BUCKET,
        Key: testKey,
      }),
    );
    const initialLastModified = initialHead.LastModified;

    // Delay to ensure timestamp difference is visible (S3 has 1-second granularity)
    // Using 10s for more realistic lifecycle test timing
    await new Promise((resolve) => setTimeout(resolve, 10000));

    // Step 3: Copy-to-self (renewal)
    // Use REPLACE to force S3 to update LastModified when copying to self
    await s3Client.send(
      new CopyObjectCommand({
        Bucket: env.LIFECYCLE_TEST_BUCKET,
        CopySource: `${env.LIFECYCLE_TEST_BUCKET}/${encodeURIComponent(testKey)}`,
        Key: testKey,
        MetadataDirective: "REPLACE",
      }),
    );

    // Step 4: Get new LastModified
    const renewedHead = await s3Client.send(
      new HeadObjectCommand({
        Bucket: env.LIFECYCLE_TEST_BUCKET,
        Key: testKey,
      }),
    );
    const renewedLastModified = renewedHead.LastModified;

    // Step 5: Cleanup (optional)
    if (cleanup) {
      await s3Client.send(
        new DeleteObjectCommand({
          Bucket: env.LIFECYCLE_TEST_BUCKET,
          Key: testKey,
        }),
      );
    }

    // Step 6: Return results
    const success =
      initialLastModified &&
      renewedLastModified &&
      renewedLastModified > initialLastModified;

    req.log.info(
      {
        testKey,
        initialLastModified,
        renewedLastModified,
        success,
        cleanup,
      },
      "Lifecycle test completed",
    );

    res.json({
      success,
      bucket: env.LIFECYCLE_TEST_BUCKET,
      testKey: cleanup ? "(cleaned up)" : testKey,
      initialLastModified: initialLastModified?.toISOString(),
      renewedLastModified: renewedLastModified?.toISOString(),
      message: success
        ? "Copy-to-self successfully reset LastModified timestamp"
        : "LastModified was not updated as expected",
    });
    return;
  } catch (error) {
    req.log.error({ error, testKey }, "Lifecycle test failed");

    // Attempt cleanup on failure
    if (cleanup) {
      try {
        await s3Client.send(
          new DeleteObjectCommand({
            Bucket: env.LIFECYCLE_TEST_BUCKET,
            Key: testKey,
          }),
        );
      } catch {
        // Ignore cleanup errors
      }
    }

    res.status(500).json({
      error: "Lifecycle test failed",
      details: error instanceof Error ? error.message : "Unknown error",
    });
    return;
  }
}
