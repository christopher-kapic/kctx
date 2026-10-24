# Overlays

Consistent overlay conventions keep create/edit/delete flows predictable.

| Action | Component | Source |
|---|---|---|
| **Create** | Dialog (centered modal) | `@starter/ui/components/dialog` |
| **Edit** | Sheet (slides from right) | `@starter/ui/components/sheet` |
| **Delete** | AlertDialog with type-to-confirm | `@starter/ui/components/alert-dialog` |
| **View details** | Dialog on desktop, Drawer on mobile (responsive) | `@starter/ui/components/responsive-dialog` |

All overlays must set `overscroll-behavior: contain` on their scrollable region so scroll doesn't bleed to the page behind. The shadcn primitives in `packages/ui/src/components/` already do this — don't override it.

## Route-Based Exceptions

Long-form authoring is not an overlay flow. When the thing being edited is a markdown or rich-text body — a document, an article, a template — the editing surface is a workspace the user needs to refresh, bookmark, recover after a crash, and paste to a colleague. A Dialog or Sheet gives it none of that: the URL never changes, a reload throws the draft away, and the list behind it keeps its own scroll and filter state alive for the entire session.

Use the nested route pattern instead:

```text
apps/web/src/routes/$lang/_app/admin/things.tsx            # layout, renders <Outlet />
apps/web/src/routes/$lang/_app/admin/things/index.tsx      # list management
apps/web/src/routes/$lang/_app/admin/things/new.tsx        # create workspace
apps/web/src/routes/$lang/_app/admin/things/$thingId.tsx   # edit workspace
```

The list route owns filtering, status toggles, delete, and navigation. Create and edit render page-level forms. See [auth-and-routing § Route sections with index children](./auth-and-routing.md#route-sections-with-index-children).

The threshold is the content, not the field count: a six-field settings form is still a Sheet. Reach for a route when the body is unbounded text, when the form has its own sub-navigation, or when losing the draft on a reload would be a real complaint. The typed CMS posts workspace ([add-ins/cms.md](./add-ins/cms.md)) is the original instance of this exception; restore it on those routes, not as a Sheet.

## Create — Dialog

```tsx
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@starter/ui/components/dialog";
import { Button } from "@starter/ui/components/button";
import { useState } from "react";

function CreatePostButton() {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button>New post</Button>} />
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Create post</DialogTitle>
          <DialogDescription>Add a new post to the blog.</DialogDescription>
        </DialogHeader>
        <CreatePostForm onSuccess={() => setOpen(false)} />
      </DialogContent>
    </Dialog>
  );
}
```

## Edit — Sheet

```tsx
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@starter/ui/components/sheet";

function EditPostSheet({
  post,
  open,
  onOpenChange,
}: {
  post: Post | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Edit post</SheetTitle>
          <SheetDescription>Update post details.</SheetDescription>
        </SheetHeader>
        {post && (
          // key={post.id} forces a remount — clean reset when switching posts
          <EditPostForm key={post.id} post={post} onSuccess={() => onOpenChange(false)} />
        )}
      </SheetContent>
    </Sheet>
  );
}
```

## Delete — AlertDialog with type-to-confirm

For destructive, irreversible actions: require the user to type the entity name. Show a copy button next to the name so they can paste.

Prefer the shared `ConfirmDeleteDialog` (`apps/web/src/components/confirm-delete-dialog.tsx`) over a one-off AlertDialog. It already widens past the default `xs`/`sm` alert max-width (typed token + two 44px actions overflow on small screens), wraps the footer, and keeps the token row `min-w-0`. If you must inline a dialog, copy those layout classes.

```tsx
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@starter/ui/components/alert-dialog";
import { Button } from "@starter/ui/components/button";
import { Input } from "@starter/ui/components/input";
import { Label } from "@starter/ui/components/label";
import { Copy } from "lucide-react";
import { useState } from "react";

function DeletePostDialog({
  post,
  open,
  onOpenChange,
  onConfirm,
}: {
  post: { id: string; title: string };
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  const [confirm, setConfirm] = useState("");
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="max-w-[calc(100%-2rem)]! sm:max-w-md! data-[size=default]:max-w-[calc(100%-2rem)]! data-[size=default]:sm:max-w-md! data-[size=sm]:max-w-[calc(100%-2rem)]!">
        <AlertDialogHeader>
          <AlertDialogTitle>Delete post</AlertDialogTitle>
          <AlertDialogDescription>
            This will permanently delete the post. This action cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="min-w-0 space-y-2">
          <Label>Type the post title to confirm:</Label>
          <div className="flex min-w-0 items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1 text-sm">{post.title}</code>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="min-h-[44px] min-w-[44px] shrink-0"
              onClick={() => navigator.clipboard.writeText(post.title)}
              aria-label="Copy post title"
            >
              <Copy className="size-4" />
            </Button>
          </div>
          <Input
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            placeholder={post.title}
          />
        </div>
        <AlertDialogFooter className="sm:flex-wrap">
          <AlertDialogCancel className="min-h-[44px] w-full sm:w-auto">Cancel</AlertDialogCancel>
          <AlertDialogAction
            className="min-h-[44px] w-full sm:w-auto"
            disabled={confirm !== post.title}
            onClick={onConfirm}
          >
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
```

## View details — Dialog on desktop, Drawer on mobile

Use the shared `ResponsiveDialog` (`@starter/ui/components/responsive-dialog`) — it packages this split once instead of every caller re-implementing the media-query branch. It inlines its own SSR-safe desktop query (`packages/ui` can't import the web app's `useIsDesktop`); don't hand-roll the split at call sites.

```tsx
import { ResponsiveDialog } from "@starter/ui/components/responsive-dialog";

function ViewPostDetails({
  post,
  open,
  onOpenChange,
}: {
  post: Post | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={onOpenChange}
      title={post?.title ?? ""}
      description="Post details"
      className="sm:max-w-lg"
    >
      {post && <PostDetails post={post} />}
    </ResponsiveDialog>
  );
}
```

## Overlay base — Base UI `render` prop

This repo uses the **Base UI** variant of shadcn, not Radix — triggers use the `render` prop pattern, not `asChild`:

```tsx
// ✅ Base UI (this repo)
<DialogTrigger render={<Button>Open</Button>} />

// ❌ Radix (not used here)
<DialogTrigger asChild><Button>Open</Button></DialogTrigger>
```

If you see `asChild` in AI-generated code, convert it to `render={<Component />}`.

## Anti-patterns

- ❌ **Using Dialog for destructive actions.** Use AlertDialog with type-to-confirm.
- ❌ **Using Sheet for create.** Sheet is for edit — it's wider and slides in, which implies "continue this work". Create should feel like a contained form.
- ❌ **Forgetting `key={entity.id}`** on edit forms inside a Sheet — state bleeds across record switches.
- ❌ **Mixing Radix `asChild` with Base UI components.** Pick one; this repo is Base UI.
