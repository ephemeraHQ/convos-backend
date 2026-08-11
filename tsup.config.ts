import { cp } from "node:fs/promises";
import { tsconfigPathsPlugin } from "esbuild-plugin-tsconfig-paths";
import { defineConfig } from "tsup";

export default defineConfig({
  // db-wait.ts is a standalone CLI run by dev/entrypoint.sh before the server
  // starts; it needs its own bundle, not to be inlined into index.js.
  entry: ["src/index.ts", "src/instrumentation.ts", "src/db-wait.ts"],
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
  // Copy the Apple root CA certs into the bundle. The JWS verifier resolves them
  // relative to `import.meta.url`, which in the bundle is `dist/index.js` → it
  // reads `dist/certs/`. tsup only emits JS, so without this step the deployed
  // image is missing the certs and every Apple verify / S2S notification fails
  // with `ENOENT: .../dist/certs/AppleRootCA-G2.cer`.
  async onSuccess() {
    await cp("src/subscriptions/certs", "dist/certs", { recursive: true });
  },
});
