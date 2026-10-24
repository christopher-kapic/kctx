import { Button } from "@starter/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@starter/ui/components/card";
import { Checkbox } from "@starter/ui/components/checkbox";
import { Input } from "@starter/ui/components/input";
import { Label } from "@starter/ui/components/label";
import { toast } from "@starter/ui/components/sileo";
import { TextField } from "@starter/ui/components/text-field";
import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import z from "zod";

import { ConsentPreferencesButton } from "@/components/consent/consent-preferences-button";
import { authClient } from "@/lib/auth-client";
import { friendly } from "@/utils/friendly-error";
import { orpc } from "@/utils/orpc";

export const Route = createFileRoute("/$lang/_app/_auth/settings/")({
  component: ProfileSettings,
});

function buildProfileSchema() {
  return z.object({
    name: z.string().min(2),
  });
}

function hasAdminRole(role: string | null | undefined): boolean {
  return (role ?? "")
    .split(",")
    .map((part) => part.trim())
    .includes("admin");
}

function ProfileSettings() {
  const { session } = Route.useRouteContext();
  const { t } = useTranslation(["settings", "auth", "common", "consent"]);
  const queryClient = useQueryClient();
  const { data: notificationPrefsData, isPending: notificationPrefsPending } = useQuery(
    orpc.settings.myNotificationPreferences.queryOptions(),
  );
  const updateNotificationPrefs = useMutation(
    orpc.settings.updateMyNotificationPreferences.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({
          queryKey: orpc.settings.myNotificationPreferences.queryKey(),
        });
        toast.success(t("settings:profile.notificationsSaved"));
      },
      onError: () => {
        toast.error(t("settings:profile.notificationsSaveError"));
      },
    }),
  );

  const form = useForm({
    defaultValues: {
      name: session.user.name || "",
    },
    onSubmit: async ({ value }) => {
      const result = await authClient.updateUser({
        name: value.name,
      });
      if (result.error) {
        console.error("[settings.updateUser]", result.error);
        toast.error(friendly(result.error, t("settings:profile.saveError")));
        return;
      }
      toast.success(t("settings:profile.saved"));
    },
    validators: {
      onSubmit: buildProfileSchema(),
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("settings:profile.title")}</CardTitle>
        <CardDescription>{t("settings:profile.description")}</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            e.stopPropagation();
            form.handleSubmit();
          }}
          className="space-y-4"
        >
          <div className="space-y-2">
            <Label>{t("auth:fields.email")}</Label>
            <Input value={session.user.email} disabled />
            <p className="text-xs text-muted-foreground">{t("settings:profile.emailReadonly")}</p>
          </div>

          <form.Field name="name">
            {(field) => (
              <TextField
                field={field}
                label={t("auth:fields.name")}
                inputMode="text"
                autoComplete="name"
              />
            )}
          </form.Field>

          <form.Subscribe
            selector={(state) => ({
              canSubmit: state.canSubmit,
              isSubmitting: state.isSubmitting,
            })}
          >
            {({ canSubmit, isSubmitting }) => (
              <Button type="submit" disabled={!canSubmit || isSubmitting}>
                {isSubmitting ? t("common:actions.saving") : t("common:actions.saveChanges")}
              </Button>
            )}
          </form.Subscribe>
        </form>

        {hasAdminRole(session.user.role) ? (
          <div className="mt-6 border-t pt-6">
            <div className="flex items-start gap-3">
              <Checkbox
                id="operational-alerts"
                checked={notificationPrefsData?.operationalAlerts ?? true}
                disabled={notificationPrefsPending || updateNotificationPrefs.isPending}
                onCheckedChange={(checked) => {
                  updateNotificationPrefs.mutate({ operationalAlerts: checked === true });
                }}
              />
              <div className="space-y-1">
                <Label htmlFor="operational-alerts">
                  {t("settings:profile.operationalAlerts")}
                </Label>
                <p className="text-sm text-muted-foreground">
                  {t("settings:profile.operationalAlertsDescription")}
                </p>
              </div>
            </div>
          </div>
        ) : null}

        <div className="mt-6 space-y-2 border-t pt-6">
          <Label>{t("consent:preferences.title")}</Label>
          <p className="text-muted-foreground text-sm">{t("consent:preferences.description")}</p>
          <ConsentPreferencesButton />
        </div>
      </CardContent>
    </Card>
  );
}
