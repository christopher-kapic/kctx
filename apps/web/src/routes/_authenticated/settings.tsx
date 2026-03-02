import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { useForm } from "@tanstack/react-form";
import {
  Save,
  Settings,
  Shield,
  ShieldCheck,
  Trash2,
  User,
  Users,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { authClient } from "@/lib/auth-client";
import { client, orpc, queryClient } from "@/utils/orpc";

export const Route = createFileRoute("/_authenticated/settings")({
  component: SettingsPage,
  beforeLoad: async () => {
    const session = await authClient.getSession();
    if (session.data?.user.role !== "admin") {
      throw redirect({ to: "/dashboard" });
    }
    return { session: session.data };
  },
});

function SiteSettingsCard() {
  const settingsQuery = useQuery(orpc.settings.get.queryOptions({}));

  const updateMutation = useMutation({
    mutationFn: (input: {
      sshCloningEnabled?: boolean;
      signupsEnabled?: boolean;
      opencodeUrl?: string;
      opencodeTimeoutMs?: number;
    }) => client.settings.update(input),
    onSuccess: () => {
      toast.success("Settings updated");
      queryClient.invalidateQueries({
        queryKey: orpc.settings.get.queryOptions({}).queryKey,
      });
    },
    onError: (error) => {
      toast.error(
        error instanceof Error ? error.message : "Failed to update settings",
      );
    },
  });

  const form = useForm({
    defaultValues: {
      opencodeUrl: settingsQuery.data?.opencodeUrl ?? "",
      opencodeTimeoutMs: String(settingsQuery.data?.opencodeTimeoutMs ?? 30000),
    },
    onSubmit: async ({ value }) => {
      const timeoutMs = parseInt(value.opencodeTimeoutMs, 10);
      updateMutation.mutate({
        opencodeUrl: value.opencodeUrl || undefined,
        opencodeTimeoutMs: isNaN(timeoutMs) ? undefined : timeoutMs,
      });
    },
  });

  if (settingsQuery.isLoading) {
    return (
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-4 w-48" />
        </CardHeader>
        <CardContent className="space-y-6">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Settings className="size-4 text-muted-foreground" />
          Site Settings
        </CardTitle>
        <CardDescription>
          Configure global settings for the kinetic-context instance
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="flex items-center justify-between">
          <div className="space-y-0.5">
            <Label>SSH Cloning</Label>
            <p className="text-xs text-muted-foreground">
              Allow cloning private repositories using SSH keys
            </p>
          </div>
          <Switch
            checked={settingsQuery.data?.sshCloningEnabled ?? true}
            onCheckedChange={(checked) => {
              updateMutation.mutate({ sshCloningEnabled: !!checked });
            }}
            disabled={updateMutation.isPending}
          />
        </div>

        <div className="flex items-center justify-between">
          <div className="space-y-0.5">
            <Label>Signups Enabled</Label>
            <p className="text-xs text-muted-foreground">
              Allow new users to create accounts
            </p>
          </div>
          <Switch
            checked={settingsQuery.data?.signupsEnabled ?? true}
            onCheckedChange={(checked) => {
              updateMutation.mutate({ signupsEnabled: !!checked });
            }}
            disabled={updateMutation.isPending}
          />
        </div>

        <div className="border-t pt-4">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              e.stopPropagation();
              form.handleSubmit();
            }}
            className="space-y-4"
          >
            <form.Field name="opencodeUrl">
              {(field) => (
                <div className="space-y-1.5">
                  <Label htmlFor={field.name}>OpenCode URL</Label>
                  <Input
                    id={field.name}
                    placeholder="http://localhost:3001"
                    value={field.state.value}
                    onBlur={field.handleBlur}
                    onChange={(e) => field.handleChange(e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    URL of the OpenCode service for AI-powered dependency queries
                  </p>
                </div>
              )}
            </form.Field>

            <form.Field name="opencodeTimeoutMs">
              {(field) => (
                <div className="space-y-1.5">
                  <Label htmlFor={field.name}>OpenCode Timeout (ms)</Label>
                  <Input
                    id={field.name}
                    type="number"
                    placeholder="30000"
                    value={field.state.value}
                    onBlur={field.handleBlur}
                    onChange={(e) => field.handleChange(e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    Timeout in milliseconds for OpenCode queries
                  </p>
                </div>
              )}
            </form.Field>

            <Button
              type="submit"
              size="sm"
              disabled={updateMutation.isPending}
            >
              <Save className="size-3.5" />
              {updateMutation.isPending ? "Saving..." : "Save OpenCode Settings"}
            </Button>
          </form>
        </div>
      </CardContent>
    </Card>
  );
}

function DeleteUserDialog({
  user,
  open,
  onOpenChange,
}: {
  user: { id: string; name: string | null; email: string };
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const deleteMutation = useMutation({
    mutationFn: () => client.users.delete({ userId: user.id }),
    onSuccess: () => {
      toast.success(`User "${user.name || user.email}" deleted`);
      queryClient.invalidateQueries({
        queryKey: orpc.users.list.queryOptions({}).queryKey,
      });
      queryClient.invalidateQueries({
        queryKey: orpc.stats.get.queryOptions({}).queryKey,
      });
      onOpenChange(false);
    },
    onError: (error) => {
      toast.error(
        error instanceof Error ? error.message : "Failed to delete user",
      );
    },
  });

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete User</AlertDialogTitle>
          <AlertDialogDescription>
            This will permanently delete the account for{" "}
            <span className="font-medium text-foreground">
              {user.name || user.email}
            </span>
            . This action cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={deleteMutation.isPending}
            onClick={() => deleteMutation.mutate()}
          >
            {deleteMutation.isPending ? "Deleting..." : "Delete User"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function UserManagementCard() {
  const { session } = Route.useRouteContext();
  const usersQuery = useQuery(orpc.users.list.queryOptions({}));
  const [deleteUser, setDeleteUser] = useState<{
    id: string;
    name: string | null;
    email: string;
  } | null>(null);

  const updateRoleMutation = useMutation({
    mutationFn: (input: { userId: string; role: "admin" | "user" }) =>
      client.users.updateRole(input),
    onSuccess: (data) => {
      toast.success(
        `${data.name || data.email} is now ${data.role === "admin" ? "an admin" : "a user"}`,
      );
      queryClient.invalidateQueries({
        queryKey: orpc.users.list.queryOptions({}).queryKey,
      });
    },
    onError: (error) => {
      toast.error(
        error instanceof Error ? error.message : "Failed to update role",
      );
    },
  });

  const formatDate = (date: string | Date) => {
    return new Date(date).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  };

  if (usersQuery.isLoading) {
    return (
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-4 w-56" />
        </CardHeader>
        <CardContent>
          <div className="rounded border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>User</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Joined</TableHead>
                  <TableHead className="w-32" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {Array.from({ length: 3 }).map((_, i) => (
                  <TableRow key={i}>
                    <TableCell>
                      <Skeleton className="h-4 w-32" />
                    </TableCell>
                    <TableCell>
                      <Skeleton className="h-4 w-16" />
                    </TableCell>
                    <TableCell>
                      <Skeleton className="h-4 w-24" />
                    </TableCell>
                    <TableCell>
                      <Skeleton className="h-4 w-20" />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Users className="size-4 text-muted-foreground" />
          User Management
        </CardTitle>
        <CardDescription>
          Manage user accounts and roles
        </CardDescription>
      </CardHeader>
      <CardContent>
        {!usersQuery.data?.length ? (
          <div className="rounded border border-dashed p-8 text-center">
            <User className="mx-auto size-8 text-muted-foreground/50" />
            <p className="mt-2 text-sm text-muted-foreground">No users found</p>
          </div>
        ) : (
          <div className="rounded border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>User</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Joined</TableHead>
                  <TableHead className="w-32" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {usersQuery.data.map((user) => {
                  const isSelf = user.id === session.user.id;
                  return (
                    <TableRow key={user.id}>
                      <TableCell>
                        <div>
                          <p className="font-medium">
                            {user.name || "Unnamed"}
                            {isSelf && (
                              <span className="ml-1.5 text-xs text-muted-foreground">
                                (you)
                              </span>
                            )}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {user.email}
                          </p>
                        </div>
                      </TableCell>
                      <TableCell>
                        {user.role === "admin" ? (
                          <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                            <ShieldCheck className="size-3" />
                            Admin
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                            <User className="size-3" />
                            User
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {formatDate(user.createdAt)}
                      </TableCell>
                      <TableCell>
                        {!isSelf && (
                          <div className="flex items-center gap-1">
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={updateRoleMutation.isPending}
                              onClick={() =>
                                updateRoleMutation.mutate({
                                  userId: user.id,
                                  role:
                                    user.role === "admin" ? "user" : "admin",
                                })
                              }
                            >
                              <Shield className="size-3.5" />
                              {user.role === "admin" ? "Demote" : "Promote"}
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="text-destructive hover:text-destructive"
                              onClick={() =>
                                setDeleteUser({
                                  id: user.id,
                                  name: user.name,
                                  email: user.email,
                                })
                              }
                            >
                              <Trash2 className="size-3.5" />
                            </Button>
                          </div>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>

      {deleteUser && (
        <DeleteUserDialog
          key={deleteUser.id}
          user={deleteUser}
          open={!!deleteUser}
          onOpenChange={(open) => {
            if (!open) setDeleteUser(null);
          }}
        />
      )}
    </Card>
  );
}

function SettingsPage() {
  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold leading-tight">Settings</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Admin settings and user management
        </p>
      </div>

      <SiteSettingsCard />
      <UserManagementCard />
    </div>
  );
}
