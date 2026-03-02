import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useForm } from "@tanstack/react-form";
import { Check, Copy, Key, Plus, XCircle } from "lucide-react";
import { useState } from "react";
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
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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

export const Route = createFileRoute("/_authenticated/api-keys")({
  component: ApiKeysPage,
});

function TableSkeleton() {
  return (
    <div className="rounded border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Created</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="w-20" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {Array.from({ length: 3 }).map((_, i) => (
            <TableRow key={i}>
              <TableCell><Skeleton className="h-4 w-32" /></TableCell>
              <TableCell><Skeleton className="h-4 w-24" /></TableCell>
              <TableCell><Skeleton className="h-4 w-16" /></TableCell>
              <TableCell><Skeleton className="h-4 w-16" /></TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Button variant="outline" size="sm" onClick={handleCopy}>
      {copied ? (
        <>
          <Check className="size-3.5" />
          Copied
        </>
      ) : (
        <>
          <Copy className="size-3.5" />
          Copy
        </>
      )}
    </Button>
  );
}

function CreateApiKeyDialog() {
  const [open, setOpen] = useState(false);
  const [createdKey, setCreatedKey] = useState<string | null>(null);

  const createMutation = useMutation({
    mutationFn: (input: { name: string }) => client.apiKey.create(input),
    onSuccess: (data) => {
      setCreatedKey(data.key);
      queryClient.invalidateQueries({
        queryKey: orpc.apiKey.list.queryOptions({}).queryKey,
      });
    },
    onError: (error) => {
      toast.error(
        error instanceof Error ? error.message : "Failed to create API key",
      );
    },
  });

  const form = useForm({
    defaultValues: {
      name: "",
    },
    onSubmit: async ({ value }) => {
      createMutation.mutate({ name: value.name });
    },
    validators: {
      onSubmit: z.object({
        name: z.string().min(1, "Name is required"),
      }),
    },
  });

  const handleClose = (nextOpen: boolean) => {
    if (!nextOpen) {
      setCreatedKey(null);
      form.reset();
      createMutation.reset();
    }
    setOpen(nextOpen);
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogTrigger render={<Button size="sm" />}>
        <Plus className="size-4" />
        Create API Key
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        {createdKey ? (
          <>
            <DialogHeader>
              <DialogTitle>API Key Created</DialogTitle>
              <DialogDescription>
                Copy your API key now. You won't be able to see it again.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              <div className="rounded border border-amber-500/30 bg-amber-500/10 p-3">
                <p className="text-xs font-medium text-amber-600 dark:text-amber-400">
                  This key will only be shown once. Store it securely.
                </p>
              </div>
              <div className="flex items-center gap-2">
                <code className="flex-1 rounded bg-muted px-3 py-2 text-xs break-all">
                  {createdKey}
                </code>
                <CopyButton text={createdKey} />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => handleClose(false)}>
                Done
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Create API Key</DialogTitle>
              <DialogDescription>
                Create a new API key for MCP authentication.
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
              <form.Field name="name">
                {(field) => (
                  <div className="space-y-1.5">
                    <Label htmlFor={field.name}>Name</Label>
                    <Input
                      id={field.name}
                      placeholder="e.g. Claude Desktop, VS Code"
                      value={field.state.value}
                      onBlur={field.handleBlur}
                      onChange={(e) => field.handleChange(e.target.value)}
                    />
                    <p className="text-xs text-muted-foreground">
                      A descriptive name to identify this key.
                    </p>
                    {field.state.meta.errors.map((error) => (
                      <p
                        key={error?.message}
                        className="text-xs text-destructive"
                      >
                        {error?.message}
                      </p>
                    ))}
                  </div>
                )}
              </form.Field>
              <DialogFooter>
                <form.Subscribe>
                  {(state) => (
                    <Button
                      type="submit"
                      disabled={!state.canSubmit || createMutation.isPending}
                      className="w-full sm:w-auto"
                    >
                      {createMutation.isPending ? "Creating..." : "Create Key"}
                    </Button>
                  )}
                </form.Subscribe>
              </DialogFooter>
            </form>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function RevokeKeyDialog({
  apiKey,
  open,
  onOpenChange,
}: {
  apiKey: { id: string; name: string };
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const revokeMutation = useMutation({
    mutationFn: () => client.apiKey.revoke({ id: apiKey.id }),
    onSuccess: () => {
      toast.success(`API key "${apiKey.name}" revoked`);
      queryClient.invalidateQueries({
        queryKey: orpc.apiKey.list.queryOptions({}).queryKey,
      });
      onOpenChange(false);
    },
    onError: (error) => {
      toast.error(
        error instanceof Error ? error.message : "Failed to revoke API key",
      );
    },
  });

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Revoke API Key</AlertDialogTitle>
          <AlertDialogDescription>
            This will permanently revoke the API key{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-xs font-medium">
              {apiKey.name}
            </code>
            . Any MCP clients using this key will lose access.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={revokeMutation.isPending}
            onClick={() => revokeMutation.mutate()}
          >
            {revokeMutation.isPending ? "Revoking..." : "Revoke Key"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function ApiKeysPage() {
  const keysQuery = useQuery(orpc.apiKey.list.queryOptions({}));
  const [revokeKey, setRevokeKey] = useState<{
    id: string;
    name: string;
  } | null>(null);

  const formatDate = (date: string | Date) => {
    return new Date(date).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  };

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold leading-tight">API Keys</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Manage your API keys for MCP authentication
          </p>
        </div>
        <CreateApiKeyDialog />
      </div>

      {keysQuery.isLoading ? (
        <TableSkeleton />
      ) : !keysQuery.data?.length ? (
        <div className="rounded border border-dashed p-8 text-center">
          <Key className="mx-auto size-8 text-muted-foreground/50" />
          <p className="mt-2 text-sm text-muted-foreground">
            No API keys yet. Create one to connect MCP clients.
          </p>
        </div>
      ) : (
        <div className="rounded border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Created</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-20" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {keysQuery.data.map((key) => (
                <TableRow key={key.id}>
                  <TableCell className="font-medium">{key.name}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatDate(key.createdAt)}
                  </TableCell>
                  <TableCell>
                    {key.revokedAt ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive">
                        <XCircle className="size-3" />
                        Revoked
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 rounded-full bg-green-500/10 px-2 py-0.5 text-xs font-medium text-green-600 dark:text-green-400">
                        <Check className="size-3" />
                        Active
                      </span>
                    )}
                  </TableCell>
                  <TableCell>
                    {!key.revokedAt && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive hover:text-destructive"
                        onClick={() =>
                          setRevokeKey({ id: key.id, name: key.name })
                        }
                      >
                        Revoke
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Key className="size-4 text-muted-foreground" />
            MCP Configuration
          </CardTitle>
          <CardDescription>
            Use your API key to connect AI tools to kinetic-context
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <p className="text-sm font-medium mb-2">Claude Desktop / Claude Code</p>
            <pre className="rounded bg-muted px-3 py-2 text-xs overflow-x-auto">
              {JSON.stringify(
                {
                  mcpServers: {
                    "kinetic-context": {
                      url: `${window.location.origin}/mcp`,
                      headers: {
                        Authorization: "Bearer kctx_YOUR_API_KEY",
                      },
                    },
                  },
                },
                null,
                2,
              )}
            </pre>
          </div>
          <div>
            <p className="text-sm font-medium mb-1">Usage</p>
            <ol className="list-decimal list-inside space-y-1 text-xs text-muted-foreground">
              <li>Create an API key above</li>
              <li>
                Replace{" "}
                <code className="rounded bg-muted px-1 py-0.5">
                  kctx_YOUR_API_KEY
                </code>{" "}
                with your actual key
              </li>
              <li>
                Add the configuration to your MCP client settings
              </li>
              <li>
                The MCP server exposes{" "}
                <code className="rounded bg-muted px-1 py-0.5">
                  list_dependencies
                </code>{" "}
                and{" "}
                <code className="rounded bg-muted px-1 py-0.5">
                  query_dependency
                </code>{" "}
                tools
              </li>
            </ol>
          </div>
        </CardContent>
      </Card>

      {revokeKey && (
        <RevokeKeyDialog
          key={revokeKey.id}
          apiKey={revokeKey}
          open={!!revokeKey}
          onOpenChange={(open) => {
            if (!open) setRevokeKey(null);
          }}
        />
      )}
    </div>
  );
}
