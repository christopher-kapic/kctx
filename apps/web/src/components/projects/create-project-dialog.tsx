import { Button } from "@starter/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@starter/ui/components/dialog";
import { Plus } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { ProjectForm } from "@/components/projects/project-form";
import { useEntityMutation } from "@/hooks/use-entity-mutation";
import { orpc } from "@/utils/orpc";

/**
 * Create → Dialog (a centered, contained form), per the overlay convention in
 * patterns/overlays.md. A Sheet here would read as "continue this work".
 *
 * Self-contained: it renders its own trigger and owns its own open state, so a
 * caller can drop it into a page header or an empty state without wiring
 * anything. The trigger uses Base UI's `render` prop — this repo's shadcn
 * variant is Base UI, not Radix, so `asChild` does not exist here.
 */
export function CreateProjectDialog() {
  const { t } = useTranslation(["projects", "common"]);
  const [open, setOpen] = useState(false);

  const create = useEntityMutation(
    orpc.projects.create.mutationOptions({
      onSuccess: () => {
        setOpen(false);
      },
    }),
    {
      // Namespace-wide: `projects.list` is the only query today, but a future
      // `projects.get` would be just as stale after a create.
      invalidateKey: orpc.projects.key(),
      successMessage: t("projects:create.success"),
    },
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Don't let a click-away discard a submission already in flight.
        if (!create.isPending) setOpen(next);
      }}
    >
      <DialogTrigger
        render={
          <Button className="min-h-[44px]">
            <Plus aria-hidden className="size-4" />
            {t("projects:actions.new")}
          </Button>
        }
      />
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("projects:create.title")}</DialogTitle>
          <DialogDescription>{t("projects:create.description")}</DialogDescription>
        </DialogHeader>
        <ProjectForm
          defaultValues={{ name: "", notes: "" }}
          submitLabel={t("projects:actions.create")}
          pendingLabel={t("projects:actions.creating")}
          isPending={create.isPending}
          // `mutate`, not `mutateAsync`: the global MutationCache handler in
          // `router.tsx` owns the error toast (mutations.md, Path A), so there
          // is no rejection for the form to await and nothing here to catch.
          onSubmit={(values) => create.mutate(values)}
        />
      </DialogContent>
    </Dialog>
  );
}
