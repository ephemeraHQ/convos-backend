import { createHmac } from "node:crypto";
import { DELETION_HASH_SECRET } from "@/config";

/**
 * Keyed pseudonymization for retained deletion data. Raw identifiers (SIWE
 * address, account id) never survive a deletion; these HMAC-SHA256 digests do.
 * The two helpers use distinct domain-separation prefixes so an identity hash
 * can never collide with an account ref even if the inputs ever overlapped.
 *
 * Stability contract: DELETION_HASH_SECRET must never rotate — a rotation
 * would orphan every DeletedIdentity barrier row (silently lifting the bar)
 * and break deletion-record lookups. See src/config.ts.
 */

const hmacHex = (input: string): string =>
  createHmac("sha256", DELETION_HASH_SECRET).update(input).digest("hex");

/**
 * Barrier hash for a deleted auth identity. Keyed by the AuthMethod natural
 * key (type + externalKey); the external key is lowercased so the hash is
 * insensitive to address casing (SIWE addresses are stored lowercased today,
 * but EIP-55 checksummed input must map to the same barrier row).
 */
export const hashDeletedIdentity = (
  type: string,
  externalKey: string,
): string => hmacHex(`identity:${type}:${externalKey.toLowerCase()}`);

/**
 * Pseudonymous reference to a deleted account, used on DeletionRecord,
 * SubscriptionTombstone, and AdminAudit deletion entries.
 */
export const hashAccountRef = (accountId: string): string =>
  hmacHex(`account:${accountId.toLowerCase()}`);
