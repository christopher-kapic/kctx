import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Box, GitFork, Key, Package, Terminal, Users } from "lucide-react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { orpc } from "@/utils/orpc";

export const Route = createFileRoute("/_authenticated/dashboard")({
  component: DashboardPage,
});

function StatsCardSkeleton() {
  return (
    <Card>
      <CardHeader>
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-3 w-16" />
      </CardHeader>
      <CardContent>
        <Skeleton className="h-8 w-12" />
      </CardContent>
    </Card>
  );
}

function DashboardPage() {
  const { session } = Route.useRouteContext();
  const isAdmin = session.user.role === "admin";

  const statsQuery = useQuery(orpc.stats.get.queryOptions({}));

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold leading-tight">Dashboard</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Welcome back, {session.user.name}
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {statsQuery.isLoading ? (
          <>
            <StatsCardSkeleton />
            <StatsCardSkeleton />
            {isAdmin && <StatsCardSkeleton />}
          </>
        ) : (
          <>
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Package className="size-4 text-muted-foreground" />
                  Packages
                </CardTitle>
                <CardDescription>Total registered packages</CardDescription>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-bold">
                  {statsQuery.data?.packages ?? 0}
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <GitFork className="size-4 text-muted-foreground" />
                  Repositories
                </CardTitle>
                <CardDescription>Cloned git repositories</CardDescription>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-bold">
                  {statsQuery.data?.repositories ?? 0}
                </p>
              </CardContent>
            </Card>

            {isAdmin && (
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Users className="size-4 text-muted-foreground" />
                    Users
                  </CardTitle>
                  <CardDescription>Registered users</CardDescription>
                </CardHeader>
                <CardContent>
                  <p className="text-2xl font-bold">
                    {statsQuery.data?.users ?? 0}
                  </p>
                </CardContent>
              </Card>
            )}
          </>
        )}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Terminal className="size-4 text-muted-foreground" />
            MCP Connection
          </CardTitle>
          <CardDescription>
            Connect your AI tools to kinetic-context via MCP
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <p className="text-sm font-medium mb-1">Endpoint</p>
            <code className="block rounded bg-muted px-3 py-2 text-xs">
              {window.location.origin}/mcp
            </code>
          </div>
          <div>
            <p className="text-sm font-medium mb-1">Authentication</p>
            <p className="text-xs text-muted-foreground">
              Use a Bearer token with your API key. Create one on the{" "}
              <a href="/api-keys" className="underline underline-offset-2">
                API Keys
              </a>{" "}
              page.
            </p>
          </div>
          <div>
            <p className="text-sm font-medium mb-2">Example configuration</p>
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
        </CardContent>
      </Card>
    </div>
  );
}
