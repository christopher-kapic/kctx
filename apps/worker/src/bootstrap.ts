/**
 * Bundled process entry. Exists purely to guarantee load-before-validate order
 * in the BUILT artifact; `src/index.ts` is still the entry for `tsx` dev runs.
 *
 * Same rule as `apps/server/src/bootstrap.ts` — read the explanation there. In
 * short: `import "@starter/env/load-dotenv"` first in `index.ts` is correct
 * under plain ESM but not after bundling, because rolldown inlines the loader
 * into the entry body while hoisting `@starter/env/shared` into a statically
 * imported chunk, and static imports evaluate first. The dynamic `import()`
 * below defers the whole graph until after the `.env` is read.
 *
 * Do not add any other static import to this file.
 *
 * See patterns/environment-variables.md § Validation vs loading (do not mix)
 */
import "@starter/env/load-dotenv";

await import("./index.js");
