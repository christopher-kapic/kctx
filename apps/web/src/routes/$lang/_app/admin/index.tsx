import { buttonVariants } from "@starter/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@starter/ui/components/card";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ListX, Settings, Users } from "lucide-react";
import { useTranslation } from "react-i18next";

import { BackupStatusCard } from "@/components/admin/backup-status-card";
import { PageHeader, PageShell } from "@/components/page-shell";

export const Route = createFileRoute("/$lang/_app/admin/")({
  component: AdminOverview,
});

function AdminOverview() {
  const { lang } = Route.useParams();
  const { t } = useTranslation(["admin", "common"]);

  return (
    <PageShell width="wide">
      <PageHeader title={t("admin:overview.title")} description={t("admin:overview.description")} />
      <BackupStatusCard />
      <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {(
          [
            { to: "/$lang/admin/users", label: t("admin:nav.users"), icon: Users },
            { to: "/$lang/admin/jobs", label: t("admin:nav.jobs"), icon: ListX },
            { to: "/$lang/admin/settings", label: t("admin:nav.settings"), icon: Settings },
          ] as const
        ).map((item) => (
          <Card key={item.to}>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <item.icon aria-hidden="true" className="size-4" />
                {item.label}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <Link
                to={item.to}
                params={{ lang }}
                className={buttonVariants({ variant: "secondary" })}
              >
                {t("common:actions.manage")}
              </Link>
            </CardContent>
          </Card>
        ))}
      </section>
    </PageShell>
  );
}
