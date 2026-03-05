import { defineConfig } from "tsdown";

export default defineConfig({
  entry: "./src/index.ts",
  format: "esm",
  outDir: "./dist",
  clean: true,
  noExternal: [/@kctx\/.*/],
  external: ["better-sqlite3", "sqlite-vec"],
});
