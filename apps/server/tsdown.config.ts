import { defineConfig } from "tsdown";

export default defineConfig({
  // Object form so the emitted file stays `dist/index.mjs` (referenced by
  // `pnpm start`, both Dockerfile CMDs, and scripts/docker-entrypoint.sh) while
  // the actual entry is the bootstrap wrapper that guarantees the root `.env` is
  // loaded before any env validation runs. See src/bootstrap.ts.
  entry: { index: "./src/bootstrap.ts" },
  format: "esm",
  outDir: "./dist",
  clean: true,
  deps: {
    // Bundle dotenv with the entrypoint helper (`@starter/env/load-dotenv`) so
    // production images do not need a resolvable `dotenv` package for the
    // server process. Validation modules never import dotenv; only the
    // entrypoint load path does.
    //
    // `dotenv` is deliberately NOT a dependency of this app — it resolves
    // transitively through `@starter/env`, which is the only workspace package
    // that declares it. Keep it there: adding it back here would let a direct
    // `import "dotenv"` compile in server code, which is exactly what
    // `pnpm env:check-entrypoints` exists to prevent.
    alwaysBundle: [/@starter\/.*/, /^worker\//, "dotenv"],
    // sharp is a native module: it loads a platform-specific binary
    // (@img/sharp-linux-x64) from node_modules at runtime. Bundling its JS
    // detaches it from that binary and crashes the server on boot ("Could not
    // load the sharp module using the linux-x64 runtime"). Keep it external so
    // it resolves from node_modules at runtime — this requires sharp to be a
    // direct dependency of this package (see package.json). (The TanStack Start
    // SSR handler at apps/web/dist/server is imported via a runtime-computed
    // specifier in src/index.ts, so rolldown leaves it external automatically —
    // no entry needed here.)
    neverBundle: ["sharp"],
  },
});
