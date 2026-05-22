import { tsconfigPathsPlugin } from "esbuild-plugin-tsconfig-paths";
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/instrumentation.ts"],
  outDir: "dist",
  format: ["esm"],
  target: "node24",
  platform: "node",
  splitting: false,
  sourcemap: true,
  clean: true,
  dts: false,
  // Externalize every bare-specifier import (anything that isn't a relative or absolute path).
  // Catches deps declared in package.json AND transitives like @opentelemetry/sdk-trace-base
  // that src/instrumentation.ts imports but aren't in package.json `dependencies`.
  external: [/^[@a-z][^./]/, /^node:/],
  tsconfig: "./tsconfig.json",
  // Resolve tsconfig path aliases (@/ and @prisma-zod/*) so they are inlined
  // into the bundle rather than left as unresolvable bare specifiers at runtime.
  esbuildPlugins: [tsconfigPathsPlugin()],
});
