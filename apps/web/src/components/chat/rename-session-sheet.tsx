import { Button } from "@starter/ui/components/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@starter/ui/components/sheet";
import { TextField } from "@starter/ui/components/text-field";
import { useForm } from "@tanstack/react-form";
import { useTranslation } from "react-i18next";
import z from "zod";

/**
 * Rename one conversation. A Sheet because the overlay convention in AGENTS.md
 * assigns Edit to a right-side sheet; the delete half is an AlertDialog with
 * type-to-confirm, same convention, in {@link SessionRail}'s caller.
 *
 * Remounted by the caller with `key={session.id}` rather than syncing its
 * default value in an effect — the reset-on-prop-change rule from
 * patterns/react-hooks-and-effects.md.
 */
export function RenameSessionSheet({
  open,
  onOpenChange,
  currentTitle,
  pending,
  onRename,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentTitle: string;
  pending: boolean;
  onRename: (title: string) => Promise<boolean>;
}) {
  const { t } = useTranslation(["chat", "common"]);

  const form = useForm({
    // The stored "" sentinel becomes an empty field, not the localized
    // placeholder: a user who opens this on an untitled conversation should be
    // typing a name, not editing the word "Untitled chat" into one.
    defaultValues: { title: currentTitle },
    onSubmit: async ({ value }) => {
      if (await onRename(value.title.trim())) onOpenChange(false);
    },
    validators: {
      // Mirrors `renameSession`'s input schema. Messages come from the
      // locale-aware Zod error map — never inline strings.
      onSubmit: z.object({ title: z.string().trim().min(1).max(100) }),
    },
  });

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="overscroll-contain">
        <SheetHeader>
          <SheetTitle>{t("chat:sessions.renameTitle")}</SheetTitle>
          <SheetDescription>{t("chat:sessions.renameDescription")}</SheetDescription>
        </SheetHeader>
        <form
          id="rename-chat-session"
          onSubmit={(e) => {
            e.preventDefault();
            e.stopPropagation();
            form.handleSubmit();
          }}
          className="space-y-2 px-4"
        >
          <form.Field name="title">
            {(field) => (
              <TextField
                field={field}
                label={t("chat:sessions.renameLabel")}
                // The sheet exists for this one field, so the caret belongs
                // in it — anywhere else costs the user a tap for nothing.
                autoFocus
                autoComplete="off"
                inputMode="text"
                maxLength={100}
              />
            )}
          </form.Field>
        </form>
        <SheetFooter>
          <Button
            type="submit"
            form="rename-chat-session"
            className="min-h-[44px]"
            disabled={pending}
          >
            {pending ? t("common:actions.saving") : t("common:actions.save")}
          </Button>
          <Button
            type="button"
            variant="outline"
            className="min-h-[44px]"
            onClick={() => onOpenChange(false)}
          >
            {t("common:actions.cancel")}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
