import crypto from "node:crypto";

const ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const RANDOM_SUFFIX_LENGTH = 24;

function mintPrefixedId(prefix: string): string {
  const bytes = crypto.randomBytes(RANDOM_SUFFIX_LENGTH);
  let suffix = "";

  for (let i = 0; i < RANDOM_SUFFIX_LENGTH; i++) {
    suffix += ALPHABET[bytes[i] % ALPHABET.length];
  }

  return `${prefix}_${suffix}`;
}

export function mintAccountId(): string {
  return mintPrefixedId("acct");
}

export function mintTemplateId(): string {
  return mintPrefixedId("tmpl");
}
