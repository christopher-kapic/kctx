import { Button } from "@starter/ui/components/button";
import { useTranslation } from "react-i18next";

import { useConsent } from "@/hooks/use-consent";

/**
 * First-visit cookie banner. Mounted once from `__root.tsx` inside
 * `<ClientOnly>` so it is never server-rendered (no hydration mismatch, and
 * nothing in the SSR HTML depends on a per-visitor decision).
 *
 * Non-modal on purpose: it does not trap focus or block the page. What
 * actually stops analytics from loading is the gate — `useAnalyticsConsent()`
 * calls `loadAnalytics()` only after a positive decision — not this UI.
 *
 * Both choices are one tap, the same size, and the same variant: under GDPR,
 * refusing must be exactly as easy as accepting. Do not promote one of these
 * buttons, shrink the other, or add a "not now" that stores nothing.
 */
export function ConsentBanner() {
  const { t } = useTranslation("consent");
  const { decided, accept, reject } = useConsent();

  if (decided) return null;

  return (
    <section
      aria-label={t("banner.title")}
      // Sits above the mobile BottomNav (z-50) and clears its 3.5rem height
      // plus the home-indicator inset; on md+ it floats as a card and the nav
      // is gone, so only the inset matters. Entrance animation is disabled
      // automatically under `prefers-reduced-motion` by the global rule in
      // packages/ui/src/styles/globals.css.
      className="fixed inset-x-0 bottom-0 z-[60] animate-in border-t bg-background/95 fade-in-0 pb-[calc(3.5rem_+_var(--safe-area-bottom))] backdrop-blur-lg slide-in-from-bottom-2 md:inset-x-auto md:right-4 md:bottom-4 md:max-w-md md:border md:pb-[var(--safe-area-bottom)] md:ring-1 md:ring-foreground/10"
      style={{
        paddingLeft: "var(--safe-area-left)",
        paddingRight: "var(--safe-area-right)",
      }}
    >
      <div className="mx-auto flex max-w-3xl flex-col gap-3 p-4">
        <div className="space-y-1">
          <p className="font-medium text-foreground text-sm">{t("banner.title")}</p>
          <p className="text-muted-foreground text-xs/relaxed">{t("banner.message")}</p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
          <Button variant="outline" size="touch" className="sm:min-w-40" onClick={reject}>
            {t("banner.reject")}
          </Button>
          <Button variant="outline" size="touch" className="sm:min-w-40" onClick={accept}>
            {t("banner.accept")}
          </Button>
        </div>
      </div>
    </section>
  );
}
