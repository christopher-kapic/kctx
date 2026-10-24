import { DEFAULT_LOCALE } from "@starter/config/locales";
import { nativeResources, resolveDeviceLocale } from "@starter/locales/native";
import * as Localization from "expo-localization";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";

// The native app ships only the `native` namespace, statically imported for
// every supported locale (Metro cannot code-split like the web app's
// `import.meta.glob`). No async loading is needed, so we initialize
// synchronously at module load and pick the device locale from
// expo-localization's ordered BCP 47 tags.
const deviceLocale = resolveDeviceLocale(
  Localization.getLocales().map((locale) => locale.languageTag),
);

if (!i18n.isInitialized) {
  void i18n.use(initReactI18next).init({
    resources: nativeResources,
    lng: deviceLocale,
    fallbackLng: DEFAULT_LOCALE,
    ns: ["native"],
    defaultNS: "native",
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  });
}

export default i18n;
