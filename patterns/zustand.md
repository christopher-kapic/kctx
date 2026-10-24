# Client State (Zustand)

[Zustand](https://zustand-demo.pmnd.rs/) is used for **client-only** state — UI preferences, ephemeral drafts, offline buffers. **Server state** (anything fetched from oRPC) belongs in TanStack Query, not Zustand.

## When to use Zustand vs TanStack Query

| State type | Tool |
|---|---|
| Data from the server | TanStack Query (`useQuery` / `useMutation`) |
| UI preferences (sidebar collapsed, theme) | Zustand with `persist` |
| Ephemeral UI state (modal open, selected tab) | Zustand (no persist) or `useState` |
| Cross-component client state | Zustand |
| URL-driven state (filters, pagination) | nuqs (URL as state) |

## Store location

Stores live in `apps/web/src/stores/`. One file per store.

The starter ships one ready-to-use exemplar, `ui-preferences.ts` (the code block below). Nothing consumes it yet by design — it exists so the first persisted store starts from the blessed shape instead of a blank file (doctor.config.jsonc suppresses `deslop/unused-file` for it; don't delete it as "unused").

## Creating a store

```ts
// apps/web/src/stores/ui-preferences.ts
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

interface UiPreferencesState {
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
}

export const useUiPreferences = create<UiPreferencesState>()(
  persist(
    (set) => ({
      sidebarCollapsed: false,
      toggleSidebar: () =>
        set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
      setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
    }),
    {
      name: "ui-preferences",
      storage: createJSONStorage(() => localStorage),
    },
  ),
);
```

## Using in a component

Illustrative only — no sidebar ships in the starter; this is how a component you write would read the exemplar store:

```tsx
function Sidebar() {
  const collapsed = useUiPreferences((state) => state.sidebarCollapsed);
  const toggle = useUiPreferences((state) => state.toggleSidebar);

  return (
    <aside className={collapsed ? "w-16" : "w-64"}>
      <button onClick={toggle}>Toggle</button>
    </aside>
  );
}
```

Always select specific state — never `const state = useStore()`. This prevents re-renders on unrelated state changes.

### Selecting multiple values

```tsx
import { useShallow } from "zustand/react/shallow";

const { collapsed, toggle } = useUiPreferences(
  useShallow((state) => ({
    collapsed: state.sidebarCollapsed,
    toggle: state.toggleSidebar,
  })),
);
```

## Store without persistence

For ephemeral state that doesn't survive page reload:

```ts
import { create } from "zustand";

interface DraftState {
  content: string;
  setContent: (content: string) => void;
  clear: () => void;
}

export const useDraft = create<DraftState>((set) => ({
  content: "",
  setContent: (content) => set({ content }),
  clear: () => set({ content: "" }),
}));
```

## Slices pattern (larger stores)

Split a store into slices when it grows beyond a single concern:

```ts
import { create } from "zustand";

interface SidebarSlice {
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
}

interface NotificationSlice {
  unreadCount: number;
  setUnreadCount: (count: number) => void;
}

type AppState = SidebarSlice & NotificationSlice;

const createSidebarSlice = (set: any): SidebarSlice => ({
  sidebarCollapsed: false,
  toggleSidebar: () =>
    set((state: AppState) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
});

const createNotificationSlice = (set: any): NotificationSlice => ({
  unreadCount: 0,
  setUnreadCount: (count) => set({ unreadCount: count }),
});

export const useAppStore = create<AppState>()((...a) => ({
  ...createSidebarSlice(...a),
  ...createNotificationSlice(...a),
}));
```

## Using outside React

```ts
// Read current state
const collapsed = useUiPreferences.getState().sidebarCollapsed;

// Update state
useUiPreferences.setState({ sidebarCollapsed: true });

// Subscribe to changes
const unsub = useUiPreferences.subscribe((state) => {
  console.log("sidebar:", state.sidebarCollapsed);
});
```

## Removal

To remove Zustand from the starter:

1. Delete `apps/web/src/stores/`
2. Remove `"zustand"` from `apps/web/package.json` dependencies
3. Remove any `useShallow` imports from components
4. Run `pnpm install` to update the lockfile
