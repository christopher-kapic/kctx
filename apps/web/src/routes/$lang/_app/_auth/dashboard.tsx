import { env } from "@starter/env/web";
import { Skeleton } from "@starter/ui/components/skeleton";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { InlineRetry } from "@/components/inline-retry";
import { PageHeader, PageShell } from "@/components/page-shell";
import { orpc } from "@/utils/orpc";

export const Route = createFileRoute("/$lang/_app/_auth/dashboard")({
  component: DashboardPage,
});

function DashboardPage() {
  const { session } = Route.useRouteContext();
  const {
    isPending: appSettingsPending,
    isError: appSettingsError,
    refetch: refetchAppSettings,
  } = useQuery(orpc.settings.getAll.queryOptions());
  const { t } = useTranslation(["common", "dashboard"]);
  const appName = env.VITE_APP_NAME;

  return (
    <PageShell width="narrow">
      {appSettingsPending ? (
        <DashboardSkeleton />
      ) : appSettingsError ? (
        <InlineRetry
          className="py-12"
          message={t("dashboard:loadFailed")}
          onRetry={() => refetchAppSettings()}
        />
      ) : (
        <PageHeader
          title={`${t("common:welcome")} ${t("common:appName", { name: appName })}`}
          description={t("dashboard:welcomeBack", { name: session.user.name })}
        />
      )}
    </PageShell>
  );
}

function DashboardSkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-5 w-64" />
    </div>
  );
}
