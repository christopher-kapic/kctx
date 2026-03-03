import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useForm } from "@tanstack/react-form";
import { Loader2, MessageCircle, Pencil, Plus, Trash2, Upload, AlertCircle } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { toast } from "sonner";
import z from "zod";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { client, orpc, queryClient } from "@/utils/orpc";
import { env } from "@kctx/env/web";

export const Route = createFileRoute("/_authenticated/packages")({
  component: PackagesPage,
});

const PACKAGE_MANAGERS = ["npm", "pip", "cargo", "go", "gem", "maven", "other"];

const baseURL =
  env.VITE_SERVER_URL ??
  (typeof window !== "undefined" ? window.location.origin : "");

function getImageUrl(packageId: string) {
  return `${baseURL}/api/packages/${packageId}/image`;
}

type PackageItem = {
  id: string;
  identifier: string;
  displayName: string;
  packageManager: string;
  defaultTag: string;
  kctxHelper: string | null;
  urls: unknown;
  Repository: {
    id: string;
    gitProvider: string;
    orgOrUser: string;
    repoName: string;
    cloneStatus: string;
  } | null;
};

function parseUrls(urls: unknown): { gitBrowser: string; website: string; docs: string } {
  const obj = (typeof urls === "object" && urls !== null ? urls : {}) as Record<string, string>;
  return {
    gitBrowser: obj.gitBrowser ?? "",
    website: obj.website ?? "",
    docs: obj.docs ?? "",
  };
}

function buildUrls(gitBrowser: string, website: string, docs: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (gitBrowser.trim()) result.gitBrowser = gitBrowser.trim();
  if (website.trim()) result.website = website.trim();
  if (docs.trim()) result.docs = docs.trim();
  return result;
}

function PackageImage({ packageId, size = 24 }: { packageId: string; size?: number }) {
  const [hasError, setHasError] = useState(false);

  if (hasError) return null;

  return (
    <img
      src={getImageUrl(packageId)}
      alt=""
      width={size}
      height={size}
      className="rounded object-contain"
      onError={() => setHasError(true)}
    />
  );
}

function TableSkeleton() {
  return (
    <div className="rounded border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Display Name</TableHead>
            <TableHead>Identifier</TableHead>
            <TableHead>Package Manager</TableHead>
            <TableHead>Repository</TableHead>
            <TableHead>Default Branch</TableHead>
            <TableHead className="w-20" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {Array.from({ length: 5 }).map((_, i) => (
            <TableRow key={i}>
              <TableCell><Skeleton className="h-4 w-28" /></TableCell>
              <TableCell><Skeleton className="h-4 w-24" /></TableCell>
              <TableCell><Skeleton className="h-4 w-16" /></TableCell>
              <TableCell><Skeleton className="h-4 w-32" /></TableCell>
              <TableCell><Skeleton className="h-4 w-16" /></TableCell>
              <TableCell><Skeleton className="h-4 w-16" /></TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function CreatePackageDialog() {
  const [open, setOpen] = useState(false);
  const [defaultBranchEdited, setDefaultBranchEdited] = useState(false);
  const [displayNameEdited, setDisplayNameEdited] = useState(false);

  const reposQuery = useQuery({
    ...orpc.repository.list.queryOptions({}),
    enabled: open,
  });

  const createRepoMutation = useMutation({
    mutationFn: (input: { gitUrl: string; isPrivate: boolean; authMethod: "HTTPS" | "SSH" | "GITHUB_APP"; sshPrivateKey?: string }) =>
      client.repository.create(input),
  });

  const createPackageMutation = useMutation({
    mutationFn: (input: { identifier: string; displayName: string; packageManager: string; defaultTag: string; kctxHelper?: string; urls: Record<string, string>; repositoryId: string }) =>
      client.package.create(input),
  });

  const form = useForm({
    defaultValues: {
      identifier: "",
      displayName: "",
      packageManager: "npm",
      gitUrl: "",
      isPrivate: false,
      defaultTag: "",
      kctxHelper: "",
      gitBrowser: "",
      website: "",
      docs: "",
    },
    onSubmit: async ({ value }) => {
      try {
        const repos = reposQuery.data ?? [];
        let repositoryId: string | undefined;

        const existing = repos.find((r) => r.gitUrl === value.gitUrl);
        if (existing) {
          repositoryId = existing.id;
          // Detect default branch for existing repo if not manually edited
          if (!defaultBranchEdited && !value.defaultTag) {
            try {
              const { defaultBranch } = await client.repository.getDefaultBranch({ id: existing.id });
              form.setFieldValue("defaultTag", defaultBranch);
              value.defaultTag = defaultBranch;
            } catch {
              value.defaultTag = "main";
            }
          }
        } else {
          const newRepo = await createRepoMutation.mutateAsync({
            gitUrl: value.gitUrl,
            isPrivate: value.isPrivate,
            authMethod: value.isPrivate ? "SSH" : "HTTPS",
          });
          repositoryId = newRepo.id;
          // Repo is cloning in background; use "main" as placeholder
          // The default branch will be auto-updated when cloning finishes
          if (!defaultBranchEdited && !value.defaultTag) {
            value.defaultTag = "main";
          }
        }

        if (!value.defaultTag) value.defaultTag = "main";

        await createPackageMutation.mutateAsync({
          identifier: value.identifier,
          displayName: value.displayName,
          packageManager: value.packageManager,
          defaultTag: value.defaultTag,
          kctxHelper: value.kctxHelper || undefined,
          urls: buildUrls(value.gitBrowser, value.website, value.docs),
          repositoryId,
        });

        toast.success("Package created successfully");
        queryClient.invalidateQueries({ queryKey: orpc.package.list.queryOptions({}).queryKey });
        queryClient.invalidateQueries({ queryKey: orpc.repository.list.queryOptions({}).queryKey });
        setOpen(false);
        form.reset();
        setDefaultBranchEdited(false);
        setDisplayNameEdited(false);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Failed to create package");
      }
    },
    validators: {
      onSubmit: z.object({
        identifier: z.string().min(1, "Identifier is required"),
        displayName: z.string().min(1, "Display name is required"),
        packageManager: z.string().min(1, "Package manager is required"),
        gitUrl: z.string().url("Must be a valid URL"),
        isPrivate: z.boolean(),
        defaultTag: z.string(),
        kctxHelper: z.string(),
        gitBrowser: z.string(),
        website: z.string(),
        docs: z.string(),
      }),
    },
  });

  const isSubmitting = createRepoMutation.isPending || createPackageMutation.isPending;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size="sm" />}>
        <Plus className="size-4" />
        Add Package
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add Package</DialogTitle>
          <DialogDescription>
            Register a new package by providing its details and git repository URL.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            e.stopPropagation();
            form.handleSubmit();
          }}
          className="space-y-4"
        >
          <form.Field name="identifier">
            {(field) => (
              <div className="space-y-1.5">
                <Label htmlFor={field.name}>Identifier</Label>
                <Input
                  id={field.name}
                  placeholder="e.g. react, express, lodash"
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => {
                    field.handleChange(e.target.value);
                    if (!displayNameEdited) {
                      const derived = e.target.value
                        .replace(/-/g, " ")
                        .replace(/^./, (c) => c.toUpperCase());
                      form.setFieldValue("displayName", derived);
                    }
                  }}
                />
                {field.state.meta.errors.map((error) => (
                  <p key={error?.message} className="text-xs text-destructive">
                    {error?.message}
                  </p>
                ))}
              </div>
            )}
          </form.Field>

          <form.Field name="displayName">
            {(field) => (
              <div className="space-y-1.5">
                <Label htmlFor={field.name}>Display Name</Label>
                <Input
                  id={field.name}
                  placeholder="e.g. React, Express, Lodash"
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onFocus={(e) => e.target.select()}
                  onChange={(e) => {
                    setDisplayNameEdited(true);
                    field.handleChange(e.target.value);
                  }}
                />
                {field.state.meta.errors.map((error) => (
                  <p key={error?.message} className="text-xs text-destructive">
                    {error?.message}
                  </p>
                ))}
              </div>
            )}
          </form.Field>

          <form.Field name="packageManager">
            {(field) => (
              <div className="space-y-1.5">
                <Label>Package Manager</Label>
                <Select
                  value={field.state.value}
                  onValueChange={(value) => field.handleChange(value ?? "npm")}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Select package manager" />
                  </SelectTrigger>
                  <SelectContent>
                    {PACKAGE_MANAGERS.map((pm) => (
                      <SelectItem key={pm} value={pm}>
                        {pm}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </form.Field>

          <form.Field name="gitUrl">
            {(field) => (
              <div className="space-y-1.5">
                <Label htmlFor={field.name}>Git URL</Label>
                <Input
                  id={field.name}
                  placeholder="https://github.com/user/repo"
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => {
                    const gitUrl = e.target.value;
                    field.handleChange(gitUrl);

                    // Auto-compute gitBrowser from HTTPS URL
                    if (gitUrl.startsWith("https://")) {
                      form.setFieldValue("gitBrowser", gitUrl.replace(/\.git$/, ""));
                    }

                    // Prefill from existing repo's sibling packages
                    const repos = reposQuery.data ?? [];
                    const matchingRepo = repos.find((r) => r.gitUrl === gitUrl);
                    if (matchingRepo && "Packages" in matchingRepo) {
                      const packages = (matchingRepo as { Packages: Array<{ urls: unknown }> }).Packages;
                      if (packages?.[0]?.urls) {
                        const siblingUrls = parseUrls(packages[0].urls);
                        if (siblingUrls.website) form.setFieldValue("website", siblingUrls.website);
                        if (siblingUrls.docs) form.setFieldValue("docs", siblingUrls.docs);
                      }
                    }
                  }}
                />
                <p className="text-xs text-muted-foreground">
                  If a repository with this URL exists, it will be linked. Otherwise a new repo will be cloned.
                </p>
                {field.state.meta.errors.map((error) => (
                  <p key={error?.message} className="text-xs text-destructive">
                    {error?.message}
                  </p>
                ))}
              </div>
            )}
          </form.Field>

          <form.Field name="isPrivate">
            {(field) => (
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id={field.name}
                  checked={field.state.value}
                  onChange={(e) => field.handleChange(e.target.checked)}
                  className="size-4 rounded border"
                />
                <Label htmlFor={field.name} className="text-xs font-normal">
                  Private repository (requires SSH key for cloning)
                </Label>
              </div>
            )}
          </form.Field>

          <form.Field name="defaultTag">
            {(field) => (
              <div className="space-y-1.5">
                <Label htmlFor={field.name}>Default Branch</Label>
                <Input
                  id={field.name}
                  placeholder="Auto-detected after clone"
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => {
                    field.handleChange(e.target.value);
                    setDefaultBranchEdited(true);
                  }}
                />
                <p className="text-xs text-muted-foreground">
                  Leave empty to auto-detect from the repository.
                </p>
                {field.state.meta.errors.map((error) => (
                  <p key={error?.message} className="text-xs text-destructive">
                    {error?.message}
                  </p>
                ))}
              </div>
            )}
          </form.Field>

          <form.Field name="gitBrowser">
            {(field) => (
              <div className="space-y-1.5">
                <Label htmlFor={field.name}>
                  Git Browser URL <span className="text-muted-foreground">(optional)</span>
                </Label>
                <Input
                  id={field.name}
                  placeholder="https://github.com/user/repo"
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(e.target.value)}
                />
              </div>
            )}
          </form.Field>

          <form.Field name="website">
            {(field) => (
              <div className="space-y-1.5">
                <Label htmlFor={field.name}>
                  Website <span className="text-muted-foreground">(optional)</span>
                </Label>
                <Input
                  id={field.name}
                  placeholder="https://example.com"
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(e.target.value)}
                />
              </div>
            )}
          </form.Field>

          <form.Field name="docs">
            {(field) => (
              <div className="space-y-1.5">
                <Label htmlFor={field.name}>
                  Documentation <span className="text-muted-foreground">(optional)</span>
                </Label>
                <Input
                  id={field.name}
                  placeholder="https://docs.example.com"
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(e.target.value)}
                />
              </div>
            )}
          </form.Field>

          <form.Field name="kctxHelper">
            {(field) => (
              <div className="space-y-1.5">
                <Label htmlFor={field.name}>
                  Helper Text <span className="text-muted-foreground">(optional)</span>
                </Label>
                <Input
                  id={field.name}
                  placeholder="Instructions for AI context"
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(e.target.value)}
                />
              </div>
            )}
          </form.Field>

          <DialogFooter>
            <form.Subscribe>
              {(state) => (
                <Button
                  type="submit"
                  disabled={!state.canSubmit || isSubmitting}
                  className="w-full sm:w-auto"
                >
                  {isSubmitting ? "Creating..." : "Create Package"}
                </Button>
              )}
            </form.Subscribe>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ImageUpload({ packageId }: { packageId: string }) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  return (
    <div className="space-y-2">
      <Label>Package Image</Label>
      <div className="flex items-center gap-3">
        <div className="flex size-16 items-center justify-center rounded border bg-muted">
          {preview ? (
            <img src={preview} alt="Preview" className="size-16 rounded object-contain" />
          ) : (
            <PackageImage packageId={packageId} size={64} />
          )}
        </div>
        <div>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file) return;

              setPreview(URL.createObjectURL(file));
              setUploading(true);

              const formData = new FormData();
              formData.append("image", file);

              try {
                const res = await fetch(getImageUrl(packageId), {
                  method: "POST",
                  body: formData,
                  credentials: "include",
                });
                if (!res.ok) throw new Error("Upload failed");
                toast.success("Image uploaded");
                queryClient.invalidateQueries({ queryKey: orpc.package.list.queryOptions({}).queryKey });
              } catch {
                toast.error("Failed to upload image");
                setPreview(null);
              } finally {
                setUploading(false);
              }
            }}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={uploading}
            onClick={() => fileInputRef.current?.click()}
          >
            <Upload className="mr-1.5 size-3.5" />
            {uploading ? "Uploading..." : "Upload Image"}
          </Button>
          <p className="mt-1 text-xs text-muted-foreground">
            Resized to 256x256 max
          </p>
        </div>
      </div>
    </div>
  );
}

function EditPackageSheet({
  pkg,
  open,
  onOpenChange,
}: {
  pkg: PackageItem;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const updateMutation = useMutation({
    mutationFn: (input: {
      id: string;
      displayName?: string;
      defaultTag?: string;
      kctxHelper?: string | null;
      urls?: Record<string, string>;
    }) => client.package.update(input),
    onSuccess: () => {
      toast.success("Package updated successfully");
      queryClient.invalidateQueries({ queryKey: orpc.package.list.queryOptions({}).queryKey });
      onOpenChange(false);
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Failed to update package");
    },
  });

  const existingUrls = parseUrls(pkg.urls);

  const form = useForm({
    defaultValues: {
      displayName: pkg.displayName,
      defaultTag: pkg.defaultTag,
      kctxHelper: pkg.kctxHelper ?? "",
      gitBrowser: existingUrls.gitBrowser,
      website: existingUrls.website,
      docs: existingUrls.docs,
    },
    onSubmit: async ({ value }) => {
      updateMutation.mutate({
        id: pkg.id,
        displayName: value.displayName,
        defaultTag: value.defaultTag,
        kctxHelper: value.kctxHelper || null,
        urls: buildUrls(value.gitBrowser, value.website, value.docs),
      });
    },
    validators: {
      onSubmit: z.object({
        displayName: z.string().min(1, "Display name is required"),
        defaultTag: z.string().min(1, "Default branch is required"),
        kctxHelper: z.string(),
        gitBrowser: z.string(),
        website: z.string(),
        docs: z.string(),
      }),
    },
  });

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right">
        <SheetHeader>
          <SheetTitle>Edit Package</SheetTitle>
          <SheetDescription>
            Update details for <code className="rounded bg-muted px-1 py-0.5 text-xs">{pkg.identifier}</code>
          </SheetDescription>
        </SheetHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            e.stopPropagation();
            form.handleSubmit();
          }}
          className="flex flex-1 flex-col gap-4 overflow-y-auto p-4"
        >
          <ImageUpload packageId={pkg.id} />

          <form.Field name="displayName">
            {(field) => (
              <div className="space-y-1.5">
                <Label htmlFor="edit-displayName">Display Name</Label>
                <Input
                  id="edit-displayName"
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(e.target.value)}
                />
                {field.state.meta.errors.map((error) => (
                  <p key={error?.message} className="text-xs text-destructive">
                    {error?.message}
                  </p>
                ))}
              </div>
            )}
          </form.Field>

          <form.Field name="defaultTag">
            {(field) => (
              <div className="space-y-1.5">
                <Label htmlFor="edit-defaultTag">Default Branch</Label>
                <Input
                  id="edit-defaultTag"
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(e.target.value)}
                />
                {field.state.meta.errors.map((error) => (
                  <p key={error?.message} className="text-xs text-destructive">
                    {error?.message}
                  </p>
                ))}
              </div>
            )}
          </form.Field>

          <form.Field name="gitBrowser">
            {(field) => (
              <div className="space-y-1.5">
                <Label htmlFor="edit-gitBrowser">
                  Git Browser URL <span className="text-muted-foreground">(optional)</span>
                </Label>
                <Input
                  id="edit-gitBrowser"
                  placeholder="https://github.com/user/repo"
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(e.target.value)}
                />
              </div>
            )}
          </form.Field>

          <form.Field name="website">
            {(field) => (
              <div className="space-y-1.5">
                <Label htmlFor="edit-website">
                  Website <span className="text-muted-foreground">(optional)</span>
                </Label>
                <Input
                  id="edit-website"
                  placeholder="https://example.com"
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(e.target.value)}
                />
              </div>
            )}
          </form.Field>

          <form.Field name="docs">
            {(field) => (
              <div className="space-y-1.5">
                <Label htmlFor="edit-docs">
                  Documentation <span className="text-muted-foreground">(optional)</span>
                </Label>
                <Input
                  id="edit-docs"
                  placeholder="https://docs.example.com"
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(e.target.value)}
                />
              </div>
            )}
          </form.Field>

          <form.Field name="kctxHelper">
            {(field) => (
              <div className="space-y-1.5">
                <Label htmlFor="edit-kctxHelper">
                  Helper Text <span className="text-muted-foreground">(optional)</span>
                </Label>
                <Input
                  id="edit-kctxHelper"
                  placeholder="Instructions for AI context"
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(e.target.value)}
                />
              </div>
            )}
          </form.Field>

          <SheetFooter>
            <form.Subscribe>
              {(state) => (
                <Button
                  type="submit"
                  disabled={!state.canSubmit || updateMutation.isPending}
                  className="w-full"
                >
                  {updateMutation.isPending ? "Saving..." : "Save Changes"}
                </Button>
              )}
            </form.Subscribe>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}

function DeletePackageDialog({
  pkg,
  open,
  onOpenChange,
}: {
  pkg: PackageItem;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [confirmText, setConfirmText] = useState("");

  const deleteMutation = useMutation({
    mutationFn: () => client.package.delete({ id: pkg.id }),
    onSuccess: () => {
      toast.success(`Package "${pkg.identifier}" deleted`);
      queryClient.invalidateQueries({ queryKey: orpc.package.list.queryOptions({}).queryKey });
      onOpenChange(false);
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Failed to delete package");
    },
  });

  const canDelete = confirmText === pkg.identifier;

  return (
    <AlertDialog
      open={open}
      onOpenChange={(open) => {
        if (!open) setConfirmText("");
        onOpenChange(open);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete Package</AlertDialogTitle>
          <AlertDialogDescription>
            This will permanently delete the package{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-xs font-medium">{pkg.identifier}</code>.
            The linked repository will not be removed.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="confirm-delete">
            Type <code className="rounded bg-muted px-1 py-0.5 text-xs font-medium">{pkg.identifier}</code> to confirm
          </Label>
          <Input
            id="confirm-delete"
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            placeholder={pkg.identifier}
          />
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={!canDelete || deleteMutation.isPending}
            onClick={() => deleteMutation.mutate()}
          >
            {deleteMutation.isPending ? "Deleting..." : "Delete"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function PackagesPage() {
  const packagesQuery = useQuery({
    ...orpc.package.list.queryOptions({}),
    refetchInterval: (query) => {
      const data = query.state.data;
      const hasCloning = data?.some(
        (pkg) => pkg.Repository?.cloneStatus === "CLONING" || pkg.Repository?.cloneStatus === "PENDING",
      );
      return hasCloning ? 2000 : false;
    },
  });
  const [editPkg, setEditPkg] = useState<PackageItem | null>(null);
  const [deletePkg, setDeletePkg] = useState<PackageItem | null>(null);

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold leading-tight">Packages</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Manage your registered packages
          </p>
        </div>
        <CreatePackageDialog />
      </div>

      {packagesQuery.isLoading ? (
        <TableSkeleton />
      ) : !packagesQuery.data?.length ? (
        <div className="rounded border border-dashed p-8 text-center">
          <p className="text-sm text-muted-foreground">
            No packages yet. Add your first package to get started.
          </p>
        </div>
      ) : (
        <div className="rounded border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Display Name</TableHead>
                <TableHead>Identifier</TableHead>
                <TableHead>Package Manager</TableHead>
                <TableHead>Repository</TableHead>
                <TableHead>Default Branch</TableHead>
                <TableHead className="w-20" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {packagesQuery.data.map((pkg) => (
                <TableRow key={pkg.id}>
                  <TableCell className="font-medium">
                    <div className="flex items-center gap-2">
                      <PackageImage packageId={pkg.id} size={24} />
                      {pkg.displayName}
                    </div>
                  </TableCell>
                  <TableCell>
                    <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                      {pkg.identifier}
                    </code>
                  </TableCell>
                  <TableCell>{pkg.packageManager}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {pkg.Repository ? (
                      <div className="flex items-center gap-1.5">
                        {pkg.Repository.cloneStatus === "CLONING" || pkg.Repository.cloneStatus === "PENDING" ? (
                          <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
                        ) : pkg.Repository.cloneStatus === "FAILED" ? (
                          <AlertCircle className="size-3.5 text-destructive" />
                        ) : null}
                        <span>
                          {`${pkg.Repository.orgOrUser}/${pkg.Repository.repoName}`}
                          {pkg.Repository.cloneStatus === "CLONING" || pkg.Repository.cloneStatus === "PENDING"
                            ? " (Cloning...)"
                            : pkg.Repository.cloneStatus === "FAILED"
                              ? " (Clone failed)"
                              : ""}
                        </span>
                      </div>
                    ) : (
                      "\u2014"
                    )}
                  </TableCell>
                  <TableCell>{pkg.defaultTag}</TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1">
                      <Link
                        to="/packages/$identifier/chat"
                        params={{ identifier: pkg.identifier }}
                      >
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          disabled={pkg.Repository?.cloneStatus !== "READY"}
                        >
                          <MessageCircle className="size-3.5" />
                          <span className="sr-only">Chat</span>
                        </Button>
                      </Link>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => setEditPkg(pkg as PackageItem)}
                      >
                        <Pencil className="size-3.5" />
                        <span className="sr-only">Edit</span>
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => setDeletePkg(pkg as PackageItem)}
                      >
                        <Trash2 className="size-3.5" />
                        <span className="sr-only">Delete</span>
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {editPkg && (
        <EditPackageSheet
          key={editPkg.id}
          pkg={editPkg}
          open={!!editPkg}
          onOpenChange={(open) => { if (!open) setEditPkg(null); }}
        />
      )}

      {deletePkg && (
        <DeletePackageDialog
          key={deletePkg.id}
          pkg={deletePkg}
          open={!!deletePkg}
          onOpenChange={(open) => { if (!open) setDeletePkg(null); }}
        />
      )}
    </div>
  );
}
