/**
 * Native (Expo) i18n resources + device-locale resolver.
 *
 * Metro cannot do dynamic imports, so the native app cannot use the web app's
 * lazy `import.meta.glob` splitting. Instead we statically import ONLY the
 * `native` namespace for every supported locale and hand them to i18next as a
 * ready-to-use resource tree. Web-only namespaces (`admin`, `marketing`, …) are
 * intentionally NOT imported here so they never bloat the app binary.
 */
import {
  DEFAULT_LOCALE,
  isSupportedLocale,
  type Locale,
  SUPPORTED_LOCALES,
} from "@starter/config/locales";

import enNative from "./en-US/native.json";
import esNative from "./es-MX/native.json";

type NativeBundle = { native: typeof enNative };

/**
 * Static i18next resource tree for the native app — one `{ native }` bundle per
 * supported locale. Shapes are enforced against the en-US source: adding a key
 * to `en-US/native.json` without mirroring it in every other locale is a
 * type error here.
 */
export const nativeResources: Record<Locale, NativeBundle> = {
  "en-US": { native: enNative },
  "es-MX": { native: esNative },
};

/**
 * Pick the best supported locale for a device, given its ordered list of BCP 47
 * language tags (e.g. from `expo-localization`'s `getLocales()`).
 *
 * Resolution order:
 *   1. Exact match against `SUPPORTED_LOCALES` (`es-MX` → `es-MX`).
 *   2. Language-prefix match (`es`, `es-AR` → `es-MX`).
 *   3. `DEFAULT_LOCALE`.
 */
export function resolveDeviceLocale(languageTags: string[]): Locale {
  for (const tag of languageTags) {
    if (isSupportedLocale(tag)) return tag;
  }
  for (const tag of languageTags) {
    const prefix = tag.split("-")[0]?.toLowerCase();
    if (!prefix) continue;
    const match = SUPPORTED_LOCALES.find(
      (locale) => locale.split("-")[0]?.toLowerCase() === prefix,
    );
    if (match) return match;
  }
  return DEFAULT_LOCALE;
}
