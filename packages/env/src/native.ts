import { createEnv } from "@t3-oss/env-core";
import { nativeVars } from "./vars/native.js";

// Declarations live in ./vars/native.ts — a side-effect-free module, so
// `pnpm env:check` can read the key set. Declare new EXPO_PUBLIC_* variables
// there, never inline in the `createEnv` call.
//
// `runtimeEnv` stays an explicit key-by-key map: Metro statically replaces each
// `process.env.EXPO_PUBLIC_*` member expression at build time, so handing over
// the whole `process.env` object would ship an empty bag to the device.
export const env = createEnv({
  clientPrefix: "EXPO_PUBLIC_",
  client: nativeVars,
  runtimeEnv: {
    EXPO_PUBLIC_SERVER_URL: process.env.EXPO_PUBLIC_SERVER_URL,
  },
  emptyStringAsUndefined: true,
});
