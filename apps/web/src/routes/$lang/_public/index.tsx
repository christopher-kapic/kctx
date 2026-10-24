import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { ConsentPreferencesButton } from "@/components/consent/consent-preferences-button";
import { PageShell } from "@/components/page-shell";

export const Route = createFileRoute("/$lang/_public/")({
  component: HomePage,
});

// Static landing copy. Replace the two `home.*` strings in
// packages/locales/src/<locale>/common.json with your own marketing copy.
function HomePage() {
  const { t } = useTranslation("common");
  return (
    <>
      <PageShell width="narrow" className="py-16 text-center">
        <h1 className="text-4xl font-semibold tracking-tight">{t("home.title")}</h1>
        <p className="mx-auto mt-4 max-w-md text-balance text-muted-foreground">
          {t("home.description")}
        </p>
      </PageShell>
      {/* Anonymous visitors must be able to withdraw consent as easily as they
          gave it, and this is the only page they are guaranteed to reach. If
          you build a real footer, move the button there. */}
      <footer className="flex justify-center px-4 pb-8">
        <ConsentPreferencesButton />
      </footer>
    </>
  );
}
