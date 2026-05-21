/**
 * Dataset loader. One JSON object per line (JSONL). Each line is an EvalCase
 * with at least `id` and `input`.
 */

import { existsSync, readFileSync } from "node:fs";
import type { EvalCase } from "./types";

export function loadCases(path: string): EvalCase[] {
  if (!existsSync(path)) {
    throw new Error(`Dataset not found: ${path}`);
  }
  const text = readFileSync(path, "utf8");
  const seen = new Set<string>();
  const cases: EvalCase[] = [];

  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("//"))
    .forEach((line, i) => {
      let obj: EvalCase;
      try {
        obj = JSON.parse(line) as EvalCase;
      } catch (err) {
        throw new Error(
          `Dataset line ${i + 1} is not valid JSON: ${String(err)}`,
        );
      }
      if (!obj.id || !obj.input) {
        throw new Error(`Dataset line ${i + 1} is missing required id/input`);
      }
      if (seen.has(obj.id)) {
        throw new Error(`Dataset has duplicate case id: ${obj.id}`);
      }
      seen.add(obj.id);
      cases.push(obj);
    });

  if (cases.length === 0) {
    throw new Error(`Dataset ${path} contained no cases`);
  }
  return cases;
}
