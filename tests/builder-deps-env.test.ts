import { existsSync, readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const readRepoFile = (path: string) =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const newOptionalEnvVars = [
  "BUILDER_OPENROUTER_API_KEY",
  "BUILDER_MODEL",
  "BUILDER_EXA_SERVICE_KEY",
  "POSTHOG_PROJECT_TOKEN",
  "POSTHOG_HOST",
] as const;

describe("Builder dependency and optional env setup", () => {
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

  test("config.ts caches each new optional env var with a non-throwing default", () => {
    // After the neekolas-feedback refactor (commit 3273f9b), these env
    // vars are cached at module load via src/config.ts instead of being
    // read at call time inside the agent-templates services. Assert:
    //   1. Each var is referenced in config.ts.
    //   2. Each is read with a fallback ("" for strings) rather than a
    //      `throw new Error`, so an unset env var does not block server
    //      startup. This is the "still optional, just cached" contract.
    const configSource = readRepoFile("src/config.ts");

    for (const envVar of newOptionalEnvVars) {
      expect(configSource).toContain(envVar);
      const throwForVar = new RegExp(`throw\\s+new\\s+Error\\([^)]*${envVar}`);
      expect(configSource).not.toMatch(throwForVar);
    }
  });
});
