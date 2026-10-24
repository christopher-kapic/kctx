import { defineConfig } from "tsdown";

export default defineConfig({
  // Object form keeps the emitted file at `dist/index.mjs` while the real entry
  // is the bootstrap wrapper. See src/bootstrap.ts and apps/server's config.
  entry: { index: "./src/bootstrap.ts" },
  format: "esm",
  outDir: "./dist",
  clean: true,
  // Bundle the workspace (@starter/*) packages into the output. The runtime
  // image (Dockerfile.worker) ships only this app's dist + node_modules — it
  // does NOT copy packages/*/dist — so anything left external would resolve to
  // a dangling node_modules symlink and crash at boot with ERR_MODULE_NOT_FOUND
  // (e.g. "Cannot find package '@starter/env'"). Mirrors apps/server.
  deps: {
    // Bundle dotenv with `@starter/env/load-dotenv` so the worker image does not
    // need a resolvable `dotenv` package at runtime. Validation modules never
    // import dotenv. `dotenv` is not a dependency of this app on purpose — it
    // resolves transitively through `@starter/env`, the only workspace package
    // that declares it. Same rule as apps/server.
    alwaysBundle: [/@starter\/.*/, "dotenv"],
    // sharp is a native module pulled in transitively via @starter/api's image
    // helpers (analyze-asset handler → @starter/api/lib/assets). Bundling its JS
    // detaches it from its platform binary (@img/sharp-linux-x64) and crashes at
    // runtime. Keep it external so it resolves from node_modules — this requires
    // sharp to be a direct dependency of this package (see package.json), so pnpm
    // places it where the bundled output can resolve it. Same rule as apps/server.
    neverBundle: ["sharp"],
  },
});
