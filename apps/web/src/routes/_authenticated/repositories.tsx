import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import {
  RefreshCw,
  Lock,
  Globe,
  Check,
  Loader2,
  AlertCircle,
  Database,
} from "lucide-react";
import { useState, useEffect } from "react";
import { toast } from "sonner";

import { authClient } from "@/lib/auth-client";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
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

export const Route = createFileRoute("/_authenticated/repositories")({
  component: RepositoriesPage,
  beforeLoad: async () => {
    const session = await authClient.getSession();
    return { isAdmin: session.data?.user.role === "admin" };
  },
});

type RepoItem = {
  id: string;
  gitProvider: string;
  orgOrUser: string;
  repoName: string;
  isPrivate: boolean;
  updatedAt: string;
  embeddingStatus: string;
  embeddingError: string | null;
  _count: { Packages: number };
};

function TableSkeleton() {
  return (
    <div className="rounded border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Provider</TableHead>
            <TableHead>Org / User</TableHead>
            <TableHead>Repository</TableHead>
            <TableHead>Visibility</TableHead>
            <TableHead>Last Updated</TableHead>
            <TableHead>Packages</TableHead>
            <TableHead>Embedding</TableHead>
            <TableHead className="w-20" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {Array.from({ length: 5 }).map((_, i) => (
            <TableRow key={i}>
              <TableCell><Skeleton className="h-4 w-24" /></TableCell>
              <TableCell><Skeleton className="h-4 w-20" /></TableCell>
              <TableCell><Skeleton className="h-4 w-28" /></TableCell>
              <TableCell><Skeleton className="h-4 w-16" /></TableCell>
              <TableCell><Skeleton className="h-4 w-24" /></TableCell>
              <TableCell><Skeleton className="h-4 w-8" /></TableCell>
              <TableCell><Skeleton className="h-4 w-16" /></TableCell>
              <TableCell><Skeleton className="h-4 w-16" /></TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function SshKeyDialog({
  open,
  onOpenChange,
  onSubmit,
  isPending,
  title,
  description,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (sshKey: string) => void;
  isPending: boolean;
  title: string;
  description: string;
}) {
  const [sshKey, setSshKey] = useState("");

  return (
    <Dialog
      open={open}
      onOpenChange={(open) => {
        if (!open) setSshKey("");
        onOpenChange(open);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="ssh-key">SSH Private Key</Label>
          <textarea
            id="ssh-key"
            className="flex min-h-32 w-full rounded border bg-transparent px-3 py-2 font-mono text-xs shadow-xs outline-none focus-visible:ring-1 focus-visible:ring-ring"
            placeholder="-----BEGIN OPENSSH PRIVATE KEY-----&#10;..."
            value={sshKey}
            onChange={(e) => setSshKey(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            Your key is sent securely and never stored.
          </p>
        </div>
        <DialogFooter>
          <Button
            disabled={!sshKey.trim() || isPending}
            onClick={() => onSubmit(sshKey)}
          >
            {isPending ? "Updating..." : "Update"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function BulkUpdateButton({ sshEnabled }: { sshEnabled: boolean }) {
  const [showSshDialog, setShowSshDialog] = useState(false);

  const bulkUpdateMutation = useMutation({
    mutationFn: (input?: { sshPrivateKey?: string }) =>
      client.repository.bulkUpdate(input),
    onSuccess: (data) => {
      const results = data.results;
      const succeeded = results.filter((r) => r.status === "success").length;
      const skipped = results.filter((r) => r.status === "skipped").length;
      const failed = results.filter((r) => r.status === "failed").length;

      if (failed > 0) {
        toast.error(
          `Updated ${succeeded}, skipped ${skipped}, failed ${failed}`,
        );
      } else {
        toast.success(
          `Updated ${succeeded} repositor${succeeded === 1 ? "y" : "ies"}${skipped > 0 ? `, skipped ${skipped}` : ""}`,
        );
      }
      queryClient.invalidateQueries({
        queryKey: orpc.repository.list.queryOptions({}).queryKey,
      });
      setShowSshDialog(false);
    },
    onError: (error) => {
      toast.error(
        error instanceof Error ? error.message : "Bulk update failed",
      );
    },
  });

  return (
    <>
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={bulkUpdateMutation.isPending}
          onClick={() => bulkUpdateMutation.mutate({})}
        >
          <RefreshCw
            className={`size-4 ${bulkUpdateMutation.isPending ? "animate-spin" : ""}`}
          />
          Update All
        </Button>
        {sshEnabled && (
          <Button
            size="sm"
            variant="outline"
            disabled={bulkUpdateMutation.isPending}
            onClick={() => setShowSshDialog(true)}
          >
            <Lock className="size-4" />
            Update All (with SSH Key)
          </Button>
        )}
      </div>

      <SshKeyDialog
        open={showSshDialog}
        onOpenChange={setShowSshDialog}
        onSubmit={(sshKey) =>
          bulkUpdateMutation.mutate({ sshPrivateKey: sshKey })
        }
        isPending={bulkUpdateMutation.isPending}
        title="Bulk Update with SSH Key"
        description="Provide an SSH private key to also update private repositories. Public repositories will be updated regardless."
      />
    </>
  );
}

function UpdateRepoButton({
  repo,
  sshEnabled,
}: {
  repo: RepoItem;
  sshEnabled: boolean;
}) {
  const [showSshDialog, setShowSshDialog] = useState(false);

  const updateMutation = useMutation({
    mutationFn: (input: { id: string; sshPrivateKey?: string }) =>
      client.repository.update(input),
    onSuccess: () => {
      toast.success(
        `Updated ${repo.orgOrUser}/${repo.repoName}`,
      );
      queryClient.invalidateQueries({
        queryKey: orpc.repository.list.queryOptions({}).queryKey,
      });
      setShowSshDialog(false);
    },
    onError: (error) => {
      toast.error(
        error instanceof Error ? error.message : "Update failed",
      );
    },
  });

  if (repo.isPrivate && sshEnabled) {
    return (
      <>
        <Button
          variant="ghost"
          size="icon-sm"
          disabled={updateMutation.isPending}
          onClick={() => setShowSshDialog(true)}
        >
          <RefreshCw
            className={`size-3.5 ${updateMutation.isPending ? "animate-spin" : ""}`}
          />
          <span className="sr-only">Update</span>
        </Button>

        <SshKeyDialog
          open={showSshDialog}
          onOpenChange={setShowSshDialog}
          onSubmit={(sshKey) =>
            updateMutation.mutate({ id: repo.id, sshPrivateKey: sshKey })
          }
          isPending={updateMutation.isPending}
          title={`Update ${repo.orgOrUser}/${repo.repoName}`}
          description="This is a private repository. Provide an SSH private key to pull the latest changes."
        />
      </>
    );
  }

  if (repo.isPrivate && !sshEnabled) {
    return null;
  }

  return (
    <Button
      variant="ghost"
      size="icon-sm"
      disabled={updateMutation.isPending}
      onClick={() => updateMutation.mutate({ id: repo.id })}
    >
      <RefreshCw
        className={`size-3.5 ${updateMutation.isPending ? "animate-spin" : ""}`}
      />
      <span className="sr-only">Update</span>
    </Button>
  );
}

function EmbeddingStatusBadge({ repo }: { repo: RepoItem }) {
  switch (repo.embeddingStatus) {
    case "INDEXING":
      return (
        <span className="inline-flex items-center gap-1 text-xs text-yellow-600">
          <Loader2 className="size-3 animate-spin" />
          Indexing...
        </span>
      );
    case "INDEXED":
      return (
        <span className="inline-flex items-center gap-1 text-xs text-green-600">
          <Check className="size-3" />
          Indexed
        </span>
      );
    case "FAILED":
      return (
        <span
          className="inline-flex items-center gap-1 text-xs text-red-600"
          title={repo.embeddingError ?? "Unknown error"}
        >
          <AlertCircle className="size-3" />
          Failed
        </span>
      );
    default:
      return (
        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
          <Database className="size-3" />
          Not indexed
        </span>
      );
  }
}

function RepositoriesPage() {
  const { isAdmin } = Route.useRouteContext();
  const reposQuery = useQuery(orpc.repository.list.queryOptions({}));
  const sshQuery = useQuery(orpc.settings.sshEnabled.queryOptions({}));

  const sshEnabled = sshQuery.data?.sshCloningEnabled ?? true;

  // Auto-refresh while any repo is indexing
  const hasIndexing = reposQuery.data?.some(
    (r: unknown) => (r as RepoItem).embeddingStatus === "INDEXING",
  );

  useEffect(() => {
    if (!hasIndexing) return;
    const interval = setInterval(() => {
      queryClient.invalidateQueries({
        queryKey: orpc.repository.list.queryOptions({}).queryKey,
      });
    }, 5000);
    return () => clearInterval(interval);
  }, [hasIndexing]);

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold leading-tight">
            Repositories
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Manage cloned git repositories and trigger updates
          </p>
        </div>
        {isAdmin && !reposQuery.isLoading && reposQuery.data?.length ? (
          <BulkUpdateButton sshEnabled={sshEnabled} />
        ) : null}
      </div>

      {reposQuery.isLoading ? (
        <TableSkeleton />
      ) : !reposQuery.data?.length ? (
        <div className="rounded border border-dashed p-8 text-center">
          <p className="text-sm text-muted-foreground">
            No repositories yet. Repositories are created when you add a
            package.
          </p>
        </div>
      ) : (
        <div className="rounded border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Provider</TableHead>
                <TableHead>Org / User</TableHead>
                <TableHead>Repository</TableHead>
                <TableHead>Visibility</TableHead>
                <TableHead>Last Updated</TableHead>
                <TableHead>Packages</TableHead>
                <TableHead>Embedding</TableHead>
                {isAdmin && <TableHead className="w-20" />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {reposQuery.data.map((repo) => {
                const r = repo as unknown as RepoItem;
                return (
                  <TableRow key={repo.id}>
                    <TableCell>
                      <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                        {repo.gitProvider}
                      </code>
                    </TableCell>
                    <TableCell>{repo.orgOrUser}</TableCell>
                    <TableCell className="font-medium">
                      {repo.repoName}
                    </TableCell>
                    <TableCell>
                      <span className="inline-flex items-center gap-1 text-xs">
                        {repo.isPrivate ? (
                          <>
                            <Lock className="size-3" />
                            Private
                          </>
                        ) : (
                          <>
                            <Globe className="size-3" />
                            Public
                          </>
                        )}
                      </span>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {new Date(repo.updatedAt).toLocaleDateString()}
                    </TableCell>
                    <TableCell>{r._count.Packages}</TableCell>
                    <TableCell>
                      <EmbeddingStatusBadge repo={r} />
                    </TableCell>
                    {isAdmin && (
                      <TableCell>
                        <UpdateRepoButton
                          repo={r}
                          sshEnabled={sshEnabled}
                        />
                      </TableCell>
                    )}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
