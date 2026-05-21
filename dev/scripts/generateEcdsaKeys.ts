import * as jose from "jose";

/**
 * Generate ECDSA P-256 key pair for JWT authentication
 *
 * Usage:
 *   pnpm tsx dev/scripts/generateEcdsaKeys.ts
 *
 * This generates a private key for the backend (JWT_PRIVATE_KEY)
 * and a public key for the gateway (JWT_PUBLIC_KEY)
 */
async function generateKeys() {
  console.log("Generating ECDSA P-256 key pair...\n");

  const { privateKey, publicKey } = await jose.generateKeyPair("ES256", {
    extractable: true,
  });

  // Export keys in PEM format
  const privateKeyPem = await jose.exportPKCS8(privateKey);
  const publicKeyPem = await jose.exportSPKI(publicKey);

  console.log("=".repeat(80));
  console.log("ECDSA P-256 Key Pair Generated Successfully");
  console.log("=".repeat(80));
  console.log("\n📝 Private Key (for Backend - JWT_PRIVATE_KEY):");
  console.log("-".repeat(80));
  console.log(privateKeyPem);

  console.log("\n📝 Public Key (for Gateway - JWT_PUBLIC_KEY):");
  console.log("-".repeat(80));
  console.log(publicKeyPem);

  console.log("\n" + "=".repeat(80));
  console.log("⚠️  IMPORTANT: Add these to your .env files");
  console.log("=".repeat(80));

  // Convert to .env format (escaped newlines)
  const privateKeyEnv = privateKeyPem.replace(/\n/g, "\\n");
  const publicKeyEnv = publicKeyPem.replace(/\n/g, "\\n");

  console.log("\n📋 Ready to paste into Backend .env:");
  console.log("-".repeat(80));
  console.log(`JWT_PRIVATE_KEY="${privateKeyEnv}"`);

  console.log("\n📋 Ready to paste into Gateway .env:");
  console.log("-".repeat(80));
  console.log(`JWT_PUBLIC_KEY="${publicKeyEnv}"`);

  console.log("\n" + "=".repeat(80));
  console.log(
    "⚠️  Keep the private key SECRET - never commit to version control!",
  );
  console.log("=".repeat(80));
}

generateKeys().catch(console.error);
