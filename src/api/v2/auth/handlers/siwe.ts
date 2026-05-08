import { SiweMessage } from "siwe";
import { SIWE_ALLOWED_CHAIN_IDS, SIWE_DOMAIN, SIWE_URI } from "@/config";

const ISSUED_AT_SKEW_MS = 5 * 60 * 1000;
const MAX_EXPIRATION_FUTURE_MS = 10 * 60 * 1000;

export class InvalidSiweError extends Error {
  constructor(public readonly reason: string) {
    super(`Invalid SIWE: ${reason}`);
    this.name = "InvalidSiweError";
  }
}

export async function verifySiwe(args: {
  message: string;
  signature: string;
  expectedNonce: string;
  now: Date;
}): Promise<{ address: string }> {
  let msg: SiweMessage;
  try {
    msg = new SiweMessage(args.message);
  } catch {
    throw new InvalidSiweError("parse");
  }

  // Defense-in-depth: siwe v3's @spruceid/siwe-parser ABNF rejects non-v1
  // at constructor time (caught above as "parse"). Keep this branch in
  // case a future siwe minor loosens parser strictness.
  if (msg.version !== "1") throw new InvalidSiweError("version");
  if (msg.domain !== SIWE_DOMAIN) throw new InvalidSiweError("domain");
  if (msg.nonce !== args.expectedNonce) throw new InvalidSiweError("nonce");
  if (!SIWE_ALLOWED_CHAIN_IDS.includes(msg.chainId)) {
    throw new InvalidSiweError("chainId");
  }
  if (msg.uri !== SIWE_URI) throw new InvalidSiweError("uri");
  if (!msg.expirationTime) throw new InvalidSiweError("expirationTime missing");

  const expMs = Date.parse(msg.expirationTime);
  if (Number.isNaN(expMs) || expMs <= args.now.getTime()) {
    throw new InvalidSiweError("expired");
  }
  if (expMs - args.now.getTime() > MAX_EXPIRATION_FUTURE_MS) {
    throw new InvalidSiweError("expirationTime too far");
  }

  if (msg.issuedAt) {
    const iat = Date.parse(msg.issuedAt);
    if (
      Number.isNaN(iat) ||
      Math.abs(iat - args.now.getTime()) > ISSUED_AT_SKEW_MS
    ) {
      throw new InvalidSiweError("issuedAt skew");
    }
  }

  if (msg.notBefore) {
    const nbf = Date.parse(msg.notBefore);
    if (!Number.isNaN(nbf) && nbf > args.now.getTime()) {
      throw new InvalidSiweError("notBefore");
    }
  }

  let result;
  try {
    // EOA-only by design: do NOT pass `opts.provider`. Doing so would enable
    // the EIP-1271 contract-wallet fallback path inside the siwe library,
    // which validates via on-chain contract call instead of EOA signature
    // recovery — a different trust model than the rest of this auth flow.
    result = await msg.verify({
      signature: args.signature,
      nonce: args.expectedNonce,
      domain: SIWE_DOMAIN,
      time: args.now.toISOString(),
    });
  } catch {
    throw new InvalidSiweError("signature");
  }
  if (!result.success) throw new InvalidSiweError("signature");

  return { address: msg.address.toLowerCase() };
}
