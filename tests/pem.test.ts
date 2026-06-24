import * as jose from "jose";
import { describe, expect, test } from "vitest";
import { normalizePemKey } from "@/utils/pem";

describe("normalizePemKey", () => {
  test("imports an ES256 key delivered as a single-line literal-\\n string", async () => {
    const { privateKey } = await jose.generateKeyPair("ES256", {
      extractable: true,
    });
    const pem = await jose.exportPKCS8(privateKey);

    const escaped = pem.trimEnd().replace(/\n/g, "\\n");
    const infisicalStyle = `"${escaped}"`;

    await expect(jose.importPKCS8(infisicalStyle, "ES256")).rejects.toThrow();

    const key = await jose.importPKCS8(
      normalizePemKey(infisicalStyle),
      "ES256",
    );
    expect(key).toBeDefined();
  });

  test("strips wrapping quotes and CRLF escapes", () => {
    const out = normalizePemKey(
      `'-----BEGIN-----\\r\\nbody\\r\\n-----END-----'`,
    );
    expect(out).toBe("-----BEGIN-----\nbody\n-----END-----");
  });

  test("leaves a real multi-line PEM untouched", () => {
    const pem = "-----BEGIN-----\nbody\n-----END-----";
    expect(normalizePemKey(pem)).toBe(pem);
  });
});
