import crypto from "node:crypto";

// Uppercase letters excluding visually ambiguous O and I
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const CODE_LENGTH = 8;

export function generateCode(): string {
  const bytes = crypto.randomBytes(CODE_LENGTH);
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return code;
}

export function generateUniqueCodes(count: number): string[] {
  const codes = new Set<string>();
  // Guard against infinite loops with a generous iteration cap
  const maxIterations = count * 10;
  let iterations = 0;
  while (codes.size < count && iterations < maxIterations) {
    codes.add(generateCode());
    iterations++;
  }
  return Array.from(codes);
}
