import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    pool: "forks",
    poolOptions: {
      forks: { singleFork: true },
    },
    isolate: false,
    fileParallelism: false,
    globals: false,
    environment: "node",
    setupFiles: ["./tests/setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
