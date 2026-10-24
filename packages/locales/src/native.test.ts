import { DEFAULT_LOCALE } from "@starter/config/locales";
import { describe, expect, it } from "vitest";

import { nativeResources, resolveDeviceLocale } from "./native";

describe("resolveDeviceLocale", () => {
  it("returns an exact supported-locale match", () => {
    expect(resolveDeviceLocale(["es-MX"])).toBe("es-MX");
    expect(resolveDeviceLocale(["en-US"])).toBe("en-US");
  });

  it("prefers an exact match over a later prefix match", () => {
    expect(resolveDeviceLocale(["en-US", "es-MX"])).toBe("en-US");
  });

  it("falls back to a language-prefix match", () => {
    expect(resolveDeviceLocale(["es"])).toBe("es-MX");
    expect(resolveDeviceLocale(["es-AR"])).toBe("es-MX");
    expect(resolveDeviceLocale(["en-GB"])).toBe("en-US");
  });

  it("is case-insensitive on the language prefix", () => {
    expect(resolveDeviceLocale(["ES-es"])).toBe("es-MX");
  });

  it("uses the first tag whose prefix is supported", () => {
    expect(resolveDeviceLocale(["fr-FR", "es-AR"])).toBe("es-MX");
  });

  it("falls back to DEFAULT_LOCALE when nothing matches", () => {
    expect(resolveDeviceLocale(["fr-FR", "de-DE"])).toBe(DEFAULT_LOCALE);
    expect(resolveDeviceLocale([])).toBe(DEFAULT_LOCALE);
  });
});

describe("nativeResources", () => {
  it("exposes a native namespace bundle for every supported locale", () => {
    expect(Object.keys(nativeResources).sort()).toEqual(["en-US", "es-MX"]);
    expect(nativeResources["en-US"].native.tabs.home).toBe("Home");
    expect(nativeResources["es-MX"].native.tabs.home).toBe("Inicio");
  });
});
