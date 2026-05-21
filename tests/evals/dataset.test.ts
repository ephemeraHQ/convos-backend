/**
 * Offline unit tests for the dataset loader. No network.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { loadCases } from "./lib/dataset";

function tmpFile(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "eval-ds-"));
  const path = join(dir, "cases.jsonl");
  writeFileSync(path, contents);
  return path;
}

describe("loadCases", () => {
  test("loads valid cases and ignores blank/comment lines", () => {
    const path = tmpFile(
      [
        '{"id":"a","input":"first","tags":["x"]}',
        "",
        "// a comment",
        '{"id":"b","input":"second"}',
      ].join("\n"),
    );
    const cases = loadCases(path);
    expect(cases.map((c) => c.id)).toEqual(["a", "b"]);
  });

  test("throws a clear error for a missing file", () => {
    expect(() => loadCases("/no/such/dataset.jsonl")).toThrow(
      /Dataset not found/,
    );
  });

  test("rejects empty / whitespace-only input", () => {
    const path = tmpFile('{"id":"a","input":"   "}');
    expect(() => loadCases(path)).toThrow(/non-empty/);
  });

  test("rejects a non-string id", () => {
    const path = tmpFile('{"id":123,"input":"hi"}');
    expect(() => loadCases(path)).toThrow(/non-empty/);
  });

  test("rejects duplicate ids", () => {
    const path = tmpFile(
      ['{"id":"dup","input":"one"}', '{"id":"dup","input":"two"}'].join("\n"),
    );
    expect(() => loadCases(path)).toThrow(/duplicate/);
  });

  test("rejects invalid JSON", () => {
    const path = tmpFile("{not json}");
    expect(() => loadCases(path)).toThrow(/not valid JSON/);
  });

  test("reports the physical file line number (not the filtered index)", () => {
    // comment (line 1), valid (line 2), invalid (line 3)
    const path = tmpFile(
      ["// comment", '{"id":"a","input":"ok"}', "{bad json}"].join("\n"),
    );
    expect(() => loadCases(path)).toThrow(/line 3 is not valid JSON/);
  });
});
