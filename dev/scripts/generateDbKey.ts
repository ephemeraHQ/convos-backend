import { getRandomValues } from "node:crypto";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { uint8ArrayToBase64 } from "uint8array-extras";
import logger from "@/utils/logger";

export const generateEncryptionKeyBase64 = () => {
  const uint8Array = getRandomValues(new Uint8Array(32));
  return uint8ArrayToBase64(uint8Array);
};

logger.info("Generating encryption key for database...");

const filePath = join(process.cwd(), ".env");

await appendFile(
  filePath,
  `XMTP_DB_ENCRYPTION_BASE_64_KEY=${generateEncryptionKeyBase64()}`,
);

logger.info(`XMTP_DB_ENCRYPTION_BASE_64_KEY appended to ${filePath}`);
