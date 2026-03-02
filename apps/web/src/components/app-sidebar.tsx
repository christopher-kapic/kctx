import { Link, useMatchRoute, useNavigate } from "@tanstack/react-router";
import {
  BarChart3,
  Key,
  LogOut,
  Package,
  Settings,
  FolderGit2,
} from "lucide-react";

import { authClient } from "@/lib/auth-client";
import { cn } from "@/lib/utils";

import { ModeToggle } from "./mode-toggle";
import { Button } from "./ui/button";
import { Skeleton } from "./ui/skeleton";

const navItems = [
  { to: "/dashboard", label: "Dashboard", icon: BarChart3 },
  { to: "/packages", label: "Packages", icon: Package },
  { to: "/repositories", label: "Repositories", icon: FolderGit2 },
  { to: "/api-keys", label: "API Keys", icon: Key },
] as const;

const adminNavItems = [
  { to: "/settings", label: "Settings", icon: Settings },
] as const;

export default function AppSidebar() {
  const navigate = useNavigate();
  const matchRoute = useMatchRoute();
  const { data: session, isPending } = authClient.useSession();

  const isAdmin = session?.user.role === "admin";

  return (
    <aside className="flex h-full w-56 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
      <div className="flex items-center gap-2 px-4 py-4">
        <span className="text-lg font-semibold tracking-tight">kctx</span>
      </div>

      <nav className="flex-1 space-y-1 px-2 py-2">
        {navItems.map(({ to, label, icon: Icon }) => {
          const isActive = matchRoute({ to, fuzzy: true });
          return (
            <Link
              key={to}
              to={to}
              className={cn(
                "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                isActive
                  ? "bg-sidebar-accent text-sidebar-accent-foreground"
                  : "text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-accent-foreground",
              )}
            >
              <Icon className="h-4 w-4" />
              {label}
            </Link>
          );
        })}

        {isAdmin && (
          <>
            <div className="my-3 border-t border-sidebar-border" />
            {adminNavItems.map(({ to, label, icon: Icon }) => {
              const isActive = matchRoute({ to, fuzzy: true });
              return (
                <Link
                  key={to}
                  to={to}
                  className={cn(
                    "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                    isActive
                      ? "bg-sidebar-accent text-sidebar-accent-foreground"
                      : "text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-accent-foreground",
                  )}
                >
                  <Icon className="h-4 w-4" />
                  {label}
                </Link>
              );
            })}
          </>
        )}
      </nav>

      <div className="border-t border-sidebar-border p-3">
        {isPending ? (
          <Skeleton className="h-9 w-full" />
        ) : session ? (
          <div className="space-y-2">
            <div className="px-1">
              <p className="truncate text-sm font-medium">{session.user.name}</p>
              <p className="truncate text-xs text-sidebar-foreground/60">
                {session.user.email}
              </p>
            </div>
            <div className="flex items-center gap-1">
              <ModeToggle />
              <Button
                variant="ghost"
                size="sm"
                className="flex-1 justify-start gap-2 text-sidebar-foreground/70"
                onClick={() => {
                  authClient.signOut({
                    fetchOptions: {
                      onSuccess: () => {
                        navigate({ to: "/login" });
                      },
                    },
                  });
                }}
              >
                <LogOut className="h-4 w-4" />
                Sign Out
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </aside>
  );
}
