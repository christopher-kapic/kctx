import { cn } from "@starter/ui/lib/utils";
import { useQueryClient } from "@tanstack/react-query";
import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import { createFileRoute, Outlet } from "@tanstack/react-router";
import { TanStackRouterDevtools } from "@tanstack/react-router-devtools";
import { useCallback } from "react";
import { AdminSetupBanner } from "@/components/admin-setup-banner";
import BottomNav from "@/components/bottom-nav";
import Header from "@/components/header";
import PullToRefresh from "@/components/pull-to-refresh";
import { useDocumentLang } from "@/hooks/use-document-lang";
import { useMobileKeyboard } from "@/hooks/use-mobile-keyboard";
import { useNavDirection } from "@/hooks/use-nav-direction";
import { useUserLocaleSync } from "@/hooks/use-user-locale-sync";

export const Route = createFileRoute("/$lang/_app")({
  // App/auth/admin surfaces depend on browser-only auth, PWA, viewport, and
  // navigation side effects. Keep this branch client-rendered while public
  // pages remain SSR-capable under `/$lang/_public`.
  ssr: false,
  component: AppShellLayout,
});

function AppShellLayout() {
  // Service-worker registration (useAppUpdate) lives in __root so public
  // pages get it too — don't re-add it here.
  useNavDirection();
  useDocumentLang();
  useUserLocaleSync();
  const mobileKeyboardOpen = useMobileKeyboard();
  const queryClient = useQueryClient();

  // Every signed-in page gets pull-to-refresh: mark all cached data stale and
  // refetch what is on screen. A page opts out with
  // `data-pull-to-refresh="off"` (see patterns/data-fetching.md).
  const handleRefresh = useCallback(() => queryClient.invalidateQueries(), [queryClient]);

  return (
    <>
      <div
        className={cn(
          "grid h-svh min-w-0 grid-rows-[auto_1fr_auto] md:grid-rows-[auto_1fr] md:pb-0",
          !mobileKeyboardOpen && "pb-[calc(3.5rem_+_var(--safe-area-bottom))]",
        )}
        style={{
          paddingTop: "var(--safe-area-top)",
          paddingLeft: "var(--safe-area-left)",
          paddingRight: "var(--safe-area-right)",
        }}
      >
        <div>
          <Header />
          <AdminSetupBanner />
        </div>
        <main
          style={{ viewTransitionName: "page" }}
          className="relative min-h-0 min-w-0 overflow-y-auto overflow-x-clip overscroll-contain [scrollbar-gutter:stable]"
        >
          <PullToRefresh onRefresh={handleRefresh}>
            <Outlet />
          </PullToRefresh>
        </main>
        <BottomNav hidden={mobileKeyboardOpen} />
      </div>
      {import.meta.env.DEV && (
        <>
          <TanStackRouterDevtools position="bottom-left" />
          <ReactQueryDevtools position="bottom" buttonPosition="bottom-right" />
        </>
      )}
    </>
  );
}
