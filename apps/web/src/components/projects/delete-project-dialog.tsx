import { useTranslation } from "react-i18next";

import { ConfirmDeleteDialog } from "@/components/confirm-delete-dialog";
import type { Project } from "@/components/projects/project-form";
import { useEntityMutation } from "@/hooks/use-entity-mutation";
import { orpc } from "@/utils/orpc";

/**
 * Delete → AlertDialog with type-to-confirm, per patterns/overlays.md.
 *
 * It wraps the shared `ConfirmDeleteDialog` instead of assembling its own
 * AlertDialog: that component already solves the layout problems a typed token
 * plus two 44px actions create on a small screen, and it pairs the token with a
 * `CopyField` so the confirmation is possible without retyping by hand.
 */
export function DeleteProjectDialog({
  project,
  open,
  onOpenChange,
}: {
  project: Project | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation(["projects", "common"]);

  const remove = useEntityMutation(
    orpc.projects.delete.mutationOptions({
      onSuccess: () => {
        onOpenChange(false);
      },
    }),
    { invalidateKey: orpc.projects.key(), successMessage: t("projects:delete.success") },
  );

  return (
    <ConfirmDeleteDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("projects:delete.title")}
      description={t("projects:delete.description")}
      // Empty while no project is selected, which also keeps the destructive
      // action disabled: the dialog refuses to match an empty token.
      confirmToken={project?.name ?? ""}
      typePrompt={t("projects:delete.typeNameToConfirm")}
      copyAriaLabel={t("projects:delete.copyNameAriaLabel")}
      inputMode="text"
      isPending={remove.isPending}
      onConfirm={() => {
        if (!project) return;
        remove.mutate({ id: project.id });
      }}
    />
  );
}
