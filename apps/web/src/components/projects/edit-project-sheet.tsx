import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@starter/ui/components/sheet";
import { useTranslation } from "react-i18next";

import { type Project, ProjectForm } from "@/components/projects/project-form";
import { useEntityMutation } from "@/hooks/use-entity-mutation";
import { orpc } from "@/utils/orpc";

/**
 * Edit → Sheet, per the overlay convention in patterns/overlays.md.
 *
 * The form inside is remounted with `key={project.id}` rather than synced in an
 * effect: changing the key tears down the old form and mounts a fresh one,
 * which is the cleanest possible reset and the reason this file contains no
 * `useEffect`. See patterns/forms.md § Edit forms.
 */
export function EditProjectSheet({
  project,
  open,
  onOpenChange,
}: {
  project: Project | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation(["projects", "common"]);

  const update = useEntityMutation(
    orpc.projects.update.mutationOptions({
      onSuccess: () => {
        onOpenChange(false);
      },
    }),
    { invalidateKey: orpc.projects.key(), successMessage: t("projects:edit.success") },
  );

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!update.isPending) onOpenChange(next);
      }}
    >
      <SheetContent className="overscroll-contain sm:max-w-md">
        <SheetHeader>
          <SheetTitle>{t("projects:edit.title")}</SheetTitle>
          <SheetDescription>{t("projects:edit.description")}</SheetDescription>
        </SheetHeader>
        {project ? (
          <ProjectForm
            key={project.id}
            className="px-4"
            defaultValues={{ name: project.name, notes: project.notes ?? "" }}
            submitLabel={t("common:actions.save")}
            pendingLabel={t("common:actions.saving")}
            isPending={update.isPending}
            onSubmit={(values) => update.mutate({ id: project.id, ...values })}
          />
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
