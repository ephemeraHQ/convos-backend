import crypto from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  buildUniqueUrlSlug,
  buildUrlSlug,
  HASH_LEN,
  hashId,
  isUrlSlug,
  MAX_SLUG_ATTEMPTS,
} from "@/utils/url-slug";

function referenceSlugHash(id: string) {
  const sha = crypto.createHash("sha1").update(id).digest("hex");
  return parseInt(sha.slice(0, 8), 16).toString(36).padStart(5, "0").slice(-5);
}

describe("slug-hash utilities", () => {
  test("exports HASH_LEN as numeric literal 5", () => {
    expect(HASH_LEN).toBe(5);
    expect(typeof HASH_LEN).toBe("number");
  });

  test("hashId returns exactly five lowercase base36 chars", () => {
    const inputs = [
      "",
      "a",
      "tmpl_abc123",
      "this-is-a-very-long-id-string-with-many-characters-1234567890",
      String.fromCharCode(0),
    ];

    for (const input of inputs) {
      const hash = hashId(input);
      expect(hash).toHaveLength(HASH_LEN);
      expect(hash).toMatch(/^[0-9a-z]{5}$/);
    }
  });

  test("hashId matches the pool reference algorithm", () => {
    for (const id of ["a", "tmpl_abc123_extra_long_456", ""]) {
      expect(hashId(id)).toBe(referenceSlugHash(id));
    }
  });

  test("hashId is deterministic across repeated calls", () => {
    const first = hashId("tmpl_abc123");

    for (let i = 0; i < 100; i++) {
      expect(hashId("tmpl_abc123")).toBe(first);
    }
  });

  test("buildUrlSlug concatenates base slug and hash with one dot", () => {
    const built = buildUrlSlug("brewski", "tmpl_abc123");

    expect(built).toBe(`brewski.${hashId("tmpl_abc123")}`);
    expect(built).toMatch(/^brewski\.[0-9a-z]{5}$/);
    expect(built.split(".")).toHaveLength(2);
  });

  test("isUrlSlug accepts a valid lowercase base36 tail", () => {
    expect(isUrlSlug("brewski.x4f9k")).toBe(true);
    expect(isUrlSlug("foo.bar.baz12")).toBe(true);
  });

  test("isUrlSlug rejects missing or invalid hash tails", () => {
    expect(isUrlSlug("brewski")).toBe(false);
    expect(isUrlSlug("brewski.")).toBe(false);
    expect(isUrlSlug("brewski.toolong")).toBe(false);
    expect(isUrlSlug("brewski.UPPER")).toBe(false);
  });
});

describe("buildUniqueUrlSlug", () => {
  test("returns the first generated slug when nothing is taken", async () => {
    const ids = ["tmpl_first", "tmpl_second"];
    let calls = 0;
    const result = await buildUniqueUrlSlug({
      baseSlug: "brewski",
      idFactory: () => ids[calls++],
      isTaken: () => Promise.resolve(false),
    });

    expect(calls).toBe(1);
    expect(result.id).toBe("tmpl_first");
    expect(result.slug).toBe(buildUrlSlug("brewski", "tmpl_first"));
  });

  test("retries with a fresh id when the slug is taken", async () => {
    const ids = ["tmpl_first", "tmpl_second", "tmpl_third"];
    let calls = 0;
    const taken = new Set([
      buildUrlSlug("brewski", "tmpl_first"),
      buildUrlSlug("brewski", "tmpl_second"),
    ]);

    const result = await buildUniqueUrlSlug({
      baseSlug: "brewski",
      idFactory: () => ids[calls++],
      isTaken: (slug) => Promise.resolve(taken.has(slug)),
    });

    expect(calls).toBe(3);
    expect(result.id).toBe("tmpl_third");
    expect(result.slug).toBe(buildUrlSlug("brewski", "tmpl_third"));
  });

  test("throws after MAX_SLUG_ATTEMPTS when every candidate is taken", async () => {
    let calls = 0;
    let caught: unknown;
    try {
      await buildUniqueUrlSlug({
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
