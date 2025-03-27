#!/usr/bin/env bun

/**
 * Generates a secure random token for use as the XMTP notification auth secret
 */
import { randomBytes } from "crypto";

// Generate a random 32-byte token and encode it as base64
const token = randomBytes(32).toString("base64");

console.log("Generated XMTP_NOTIFICATION_SECRET:");
console.log(token);
console.log("\nAdd this to your .env file as:");
console.log(`XMTP_NOTIFICATION_SECRET=${token}`);
