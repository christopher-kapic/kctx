import { Outlet, createFileRoute, redirect } from "@tanstack/react-router";

import AppSidebar from "@/components/app-sidebar";
import { authClient } from "@/lib/auth-client";

export const Route = createFileRoute("/_authenticated")({
  component: AuthenticatedLayout,
  beforeLoad: async () => {
    const session = await authClient.getSession();
    if (!session.data) {
      throw redirect({ to: "/login" });
    }
    return { session: session.data };
  },
});

function AuthenticatedLayout() {
  return (
    <div className="flex h-svh">
      <AppSidebar />
      <main className="flex-1 overflow-y-auto">
        <Outlet />
      </main>
    </div>
  );
}
