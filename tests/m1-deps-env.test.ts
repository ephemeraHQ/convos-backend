import { existsSync, readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";

const readRepoFile = (path: string) =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const newOptionalEnvVars = [
  "BUILDER_OPENROUTER_API_KEY",
  "BUILDER_MODEL",
  "EXA_SERVICE_KEY",
  "POSTHOG_API_KEY",
  "POSTHOG_HOST",
] as const;

describe("M1 dependency and optional env setup", () => {
  test("pins posthog-node as an installed production dependency", () => {
    const packageJson = JSON.parse(readRepoFile("package.json")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };

    expect(packageJson.dependencies?.["posthog-node"]).toBe("5.33.3");
    expect(packageJson.devDependencies?.["posthog-node"]).toBeUndefined();
    expect(
      existsSync(
        new URL("../node_modules/posthog-node/package.json", import.meta.url),
      ),
    ).toBe(true);
  });

  test("documents new lazy-read env vars with empty defaults", () => {
    const envExample = readRepoFile(".env.example");

    for (const envVar of newOptionalEnvVars) {
      expect(envExample).toContain(`\n${envVar}=\n`);
    }
  });

  test("does not require new optional env vars at config load time", () => {
    const configSource = readRepoFile("src/config.ts");

    for (const envVar of newOptionalEnvVars) {
      expect(configSource).not.toContain(envVar);
    }
  });
});
