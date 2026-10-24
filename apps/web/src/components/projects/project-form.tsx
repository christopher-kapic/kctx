import type { AppRouterClient } from "@starter/api/routers/index";
import { Button } from "@starter/ui/components/button";
import { TextareaField, TextField } from "@starter/ui/components/text-field";
import { useForm } from "@tanstack/react-form";
import { useTranslation } from "react-i18next";
import { z } from "zod";

/**
 * One row of `projects.list`, exactly as the server projects it. Derived from
 * the router client rather than re-declared: types flow from the server with no
 * codegen, so a changed projection cannot leave this shape behind.
 */
export type Project = Awaited<ReturnType<AppRouterClient["projects"]["list"]>>["items"][number];

/** What a submitted form hands its caller — already trimmed and normalized. */
export type ProjectFormValues = { name: string; notes: string | undefined };

/**
 * Mirrors `projects.create` / `projects.update`'s input schema. Bare
 * validators, no inline messages: the copy comes from the locale-aware Zod
 * error map (`apps/web/src/i18n/zod.ts`) and switches with the language. The
 * server validates again at the procedure boundary — this half is for feedback,
 * never for trust. See patterns/forms.md.
 */
const projectFormSchema = z.object({
  name: z.string().trim().min(1).max(120),
  notes: z.string().trim().max(10_000),
});

/**
 * The name + notes form, shared by the create Dialog and the edit Sheet.
 *
 * Extracted at two call sites rather than three because the two are the *same*
 * form — same fields, same schema, same normalization — differing only in where
 * the values go. Duplicating it would mean two copies of one server contract,
 * and the second copy is the one that drifts.
 *
 * It submits through `onSubmit` and renders `isPending`; it owns no mutation,
 * because each overlay has a different success story.
 */
export function ProjectForm({
  defaultValues,
  submitLabel,
  pendingLabel,
  isPending,
  className,
  onSubmit,
}: {
  defaultValues: { name: string; notes: string };
  submitLabel: string;
  pendingLabel: string;
  isPending: boolean;
  className?: string;
  onSubmit: (values: ProjectFormValues) => void;
}) {
  const { t } = useTranslation(["projects"]);

  const form = useForm({
    defaultValues,
    validators: { onChange: projectFormSchema },
    onSubmit: ({ value }) => {
      onSubmit({
        name: value.name.trim(),
        // An empty textarea is "no notes", not a note that says nothing. The
        // procedure normalizes this too — this is the half that keeps the
        // request honest, not the half that enforces it.
        notes: value.notes.trim() || undefined,
      });
    },
  });

  return (
    <form
      onSubmit={(e) => {
        // TanStack Form does not call these for you: without them the browser
        // submits the form via GET and reloads the page.
        e.preventDefault();
        e.stopPropagation();
        form.handleSubmit();
      }}
      className={className}
    >
      <form.Field name="name">
        {(field) => (
          <TextField
            field={field}
            label={t("projects:fields.name")}
            placeholder={t("projects:fields.namePlaceholder")}
            // A project name has no autofill token that describes it, and
            // `type="text"` implies no keyboard — so both props are stated, as
            // the prop union requires. See patterns/forms.md.
            inputMode="text"
            autoComplete="off"
            maxLength={120}
            className="space-y-1.5"
          />
        )}
      </form.Field>

      <form.Field name="notes">
        {(field) => (
          <TextareaField
            field={field}
            label={t("projects:fields.notes")}
            description={t("projects:fields.notesDescription")}
            autoComplete="off"
            rows={4}
            maxLength={10000}
            className="mt-3 space-y-1.5"
          />
        )}
      </form.Field>

      {/* Always with a selector: an unnarrowed subscription re-renders this
          button on every keystroke. */}
      <form.Subscribe selector={(state) => state.canSubmit}>
        {(canSubmit) => (
          <Button
            type="submit"
            className="mt-4 min-h-[44px] w-full"
            disabled={!canSubmit || isPending}
          >
            {isPending ? pendingLabel : submitLabel}
          </Button>
        )}
      </form.Subscribe>
    </form>
  );
}
