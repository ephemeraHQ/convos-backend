import crypto from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  buildSlug,
  buildUniqueSlug,
  HASH_LEN,
  isHashedSlug,
  MAX_SLUG_ATTEMPTS,
  slugHash,
} from "@/utils/slug-hash";

function referenceSlugHash(id: string) {
  const sha = crypto.createHash("sha1").update(id).digest("hex");
  return parseInt(sha.slice(0, 8), 16).toString(36).padStart(5, "0").slice(-5);
}

describe("slug-hash utilities", () => {
  test("exports HASH_LEN as numeric literal 5", () => {
    expect(HASH_LEN).toBe(5);
    expect(typeof HASH_LEN).toBe("number");
  });

  test("slugHash returns exactly five lowercase base36 chars", () => {
    const inputs = [
      "",
      "a",
      "tmpl_abc123",
      "this-is-a-very-long-id-string-with-many-characters-1234567890",
      String.fromCharCode(0),
    ];

    for (const input of inputs) {
      const hash = slugHash(input);
      expect(hash).toHaveLength(HASH_LEN);
      expect(hash).toMatch(/^[0-9a-z]{5}$/);
    }
  });

  test("slugHash matches the pool reference algorithm", () => {
    for (const id of ["a", "tmpl_abc123_extra_long_456", ""]) {
      expect(slugHash(id)).toBe(referenceSlugHash(id));
    }
  });

  test("slugHash is deterministic across repeated calls", () => {
    const first = slugHash("tmpl_abc123");

    for (let i = 0; i < 100; i++) {
      expect(slugHash("tmpl_abc123")).toBe(first);
    }
  });

  test("buildSlug concatenates base slug and hash with one dot", () => {
    const built = buildSlug("brewski", "tmpl_abc123");

    expect(built).toBe(`brewski.${slugHash("tmpl_abc123")}`);
    expect(built).toMatch(/^brewski\.[0-9a-z]{5}$/);
    expect(built.split(".")).toHaveLength(2);
  });

  test("isHashedSlug accepts a valid lowercase base36 tail", () => {
    expect(isHashedSlug("brewski.x4f9k")).toBe(true);
    expect(isHashedSlug("foo.bar.baz12")).toBe(true);
  });

  test("isHashedSlug rejects missing or invalid hash tails", () => {
    expect(isHashedSlug("brewski")).toBe(false);
    expect(isHashedSlug("brewski.")).toBe(false);
    expect(isHashedSlug("brewski.toolong")).toBe(false);
    expect(isHashedSlug("brewski.UPPER")).toBe(false);
  });
});

describe("buildUniqueSlug", () => {
  test("returns the first generated slug when nothing is taken", async () => {
    const ids = ["tmpl_first", "tmpl_second"];
    let calls = 0;
    const result = await buildUniqueSlug({
      baseSlug: "brewski",
      idFactory: () => ids[calls++],
      isTaken: () => Promise.resolve(false),
    });

    expect(calls).toBe(1);
    expect(result.id).toBe("tmpl_first");
    expect(result.slug).toBe(buildSlug("brewski", "tmpl_first"));
  });

  test("retries with a fresh id when the slug is taken", async () => {
    const ids = ["tmpl_first", "tmpl_second", "tmpl_third"];
    let calls = 0;
    const taken = new Set([
      buildSlug("brewski", "tmpl_first"),
      buildSlug("brewski", "tmpl_second"),
    ]);

    const result = await buildUniqueSlug({
      baseSlug: "brewski",
      idFactory: () => ids[calls++],
      isTaken: (slug) => Promise.resolve(taken.has(slug)),
    });

    expect(calls).toBe(3);
    expect(result.id).toBe("tmpl_third");
    expect(result.slug).toBe(buildSlug("brewski", "tmpl_third"));
  });

  test("throws after MAX_SLUG_ATTEMPTS when every candidate is taken", async () => {
    let calls = 0;
    let caught: unknown;
    try {
      await buildUniqueSlug({
        baseSlug: "brewski",
        idFactory: () => `tmpl_${calls++}`,
        isTaken: () => Promise.resolve(true),
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/exhausted 8 attempts/);
    expect(calls).toBe(MAX_SLUG_ATTEMPTS);
  });
});
