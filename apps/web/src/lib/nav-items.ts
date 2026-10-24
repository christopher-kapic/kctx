import { isAdminRole } from "@starter/auth/roles";
import type { LucideIcon } from "lucide-react";
import { FolderKanban, Home, LayoutDashboard, MessageSquare, Settings, Shield } from "lucide-react";

export type NavDirection = "forward" | "back" | "none";
type NavAudience = "public" | "authenticated" | "admin";
type NavPlacement = "desktop" | "mobile" | "userMenu";
export type AppNavPath =
  | "/"
  | "/dashboard"
  | "/projects"
  | "/chat"
  | "/settings"
  | "/admin"
  | "/settings/security";
export type LangNavRoute =
  | "/$lang"
  | "/$lang/dashboard"
  | "/$lang/projects"
  | "/$lang/chat"
  | "/$lang/settings"
  | "/$lang/admin"
  | "/$lang/settings/security";

export type RouteNavItem = {
  /** Path WITHOUT the `/$lang/` prefix, starts with "/". Use "/" for root. */
  path: AppNavPath;
  /** Translation key. App nav keys live in `nav`; nested nav may use another namespace. */
  labelKey: string;
  /** Icon rendered by shell navigation surfaces. */
  icon: LucideIcon;
  /** `activeOptions.exact` for the <Link>. */
  exact: boolean;
};

export type AppNavItem = RouteNavItem & {
  id: "home" | "dashboard" | "projects" | "chat" | "settings" | "admin";
  audience: NavAudience;
  placements: readonly NavPlacement[];
};

type VisibleNavInput = {
  placement: NavPlacement;
  isAuthenticated: boolean;
  role?: unknown;
  /**
   * Server-reported chat enablement (`chat.config`), or `undefined` while that
   * query is in flight.
   *
   * UNDEFINED MEANS SHOW IT, and that asymmetry is the point: the enabled
   * deployment is the common one, so treating "not yet known" as disabled would
   * make the entry pop into every nav on every cold load. Only an explicit
   * `false` removes it, which costs the rare disabled deployment one frame of a
   * link that then goes away — and even then the page behind it explains
   * itself and the procedures refuse. Hiding the entry is tidiness, never a
   * security control.
   */
  chatEnabled?: boolean;
};

const appNavItems: AppNavItem[] = [
  {
    id: "home",
    path: "/",
    labelKey: "items.home",
    icon: Home,
    exact: true,
    audience: "public",
    placements: ["desktop", "mobile"],
  },
  {
    id: "dashboard",
    path: "/dashboard",
    labelKey: "items.dashboard",
    icon: LayoutDashboard,
    exact: false,
    audience: "authenticated",
    placements: ["desktop", "mobile"],
  },
  {
    // The golden-path example feature (patterns/golden-path.md). It sits here
    // for the same reason every other app destination does: this array is what
    // renders the desktop header AND the mobile bottom bar.
    id: "projects",
    path: "/projects",
    labelKey: "items.projects",
    icon: FolderKanban,
    exact: false,
    audience: "authenticated",
    placements: ["desktop", "mobile"],
  },
  {
    // Same placements and audience as `dashboard` — an authenticated top-level
    // app destination. Registered here rather than linked ad hoc because this
    // array is what renders the desktop header AND the mobile bottom bar; a
    // route missing from it is reachable only by typing its URL.
    id: "chat",
    path: "/chat",
    labelKey: "items.chat",
    icon: MessageSquare,
    exact: false,
    audience: "authenticated",
    placements: ["desktop", "mobile"],
  },
  {
    id: "settings",
    path: "/settings",
    labelKey: "items.settings",
    icon: Settings,
    exact: false,
    audience: "authenticated",
    placements: ["desktop", "mobile", "userMenu"],
  },
  {
    id: "admin",
    path: "/admin",
    labelKey: "items.admin",
    icon: Shield,
    exact: false,
    audience: "admin",
    placements: ["desktop", "mobile", "userMenu"],
  },
];

function canSeeNavItem(
  item: AppNavItem,
  input: Pick<VisibleNavInput, "isAuthenticated" | "role" | "chatEnabled">,
) {
  if (item.audience === "public") return true;
  if (!input.isAuthenticated) return false;
  // A deployment without `CHAT_ENABLED` + `OPENROUTER_API_KEY` has no
  // conversation to offer, so it should not advertise one.
  if (item.id === "chat" && input.chatEnabled === false) return false;
  if (item.audience === "authenticated") return true;
  return isAdminRole(input.role);
}

export function getNavItems(input: VisibleNavInput): AppNavItem[] {
  return appNavItems.filter(
    (item) => item.placements.includes(input.placement) && canSeeNavItem(item, input),
  );
}

export function toLangRoute(path: AppNavPath): LangNavRoute {
  if (path === "/") return "/$lang";
  return `/$lang${path}` as LangNavRoute;
}

/**
 * Settings sub-nav tabs, in left→right visual order. The array order is the
 * source of truth for `getNavDirection`'s sibling slide direction, so it MUST
 * match the order rendered in `settings.tsx`. Reuses the existing i18n keys.
 */
export const settingsNavItems: RouteNavItem[] = [
  {
    path: "/settings",
    labelKey: "settings:navProfile",
    icon: Settings,
    exact: true,
  },
  {
    path: "/settings/security",
    labelKey: "settings:navSecurity",
    icon: Shield,
    exact: false,
  },
];

const NAV_LISTS: RouteNavItem[][] = [appNavItems, settingsNavItems];

// Precomputed path → position lookups (one per list, since a path like
// `/settings` can appear in several lists) so `getNavDirection` does Map reads
// on every navigation instead of scanning the arrays with `findIndex`.
const NAV_INDEX_MAPS: ReadonlyMap<string, number>[] = NAV_LISTS.map(
  (list) => new Map(list.map((item, index) => [item.path, index])),
);

export function stripLangPrefix(pathname: string): string {
  const match = pathname.match(/^\/[a-z]{2}(?:-[A-Z]{2})?(\/.*)?$/i);

  if (!match) {
    return pathname;
  }

  const rest = match[1] ?? "/";

  if (rest === "" || rest === "/") {
    return "/";
  }

  return rest;
}

export function getNavDirection(fromPath: string, toPath: string): NavDirection {
  if (fromPath === toPath) {
    return "none";
  }

  for (const indexMap of NAV_INDEX_MAPS) {
    const fromIndex = indexMap.get(fromPath);
    const toIndex = indexMap.get(toPath);

    if (fromIndex !== undefined && toIndex !== undefined) {
      return toIndex < fromIndex ? "back" : "forward";
    }
  }

  if (fromPath !== "/" && toPath.startsWith(`${fromPath}/`)) {
    return "forward";
  }

  if (toPath !== "/" && fromPath.startsWith(`${toPath}/`)) {
    return "back";
  }

  return "forward";
}
