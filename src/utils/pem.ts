export const normalizePemKey = (raw: string): string =>
  raw
    .trim()
    .replace(/^(['"])([\s\S]*)\1$/, "$2")
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n");
