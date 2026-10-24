import { originUrl } from "../url.js";

// ---------------------------------------------------------------------------
// Expo client variable DECLARATIONS. See ./shared.ts for why these live in a
// side-effect-free module of their own.
//
// PUBLIC: every one of these is inlined into the app bundle. Never a secret.
// ---------------------------------------------------------------------------

export const nativeVars = {
  EXPO_PUBLIC_SERVER_URL: originUrl("EXPO_PUBLIC_SERVER_URL"),
};
