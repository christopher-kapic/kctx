import { Button } from "@starter/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@starter/ui/components/dropdown-menu";
import { Skeleton } from "@starter/ui/components/skeleton";
import { MoreVertical, Pencil, Plus, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import { InlineRetry } from "@/components/inline-retry";

/**
 * Session switcher. Rendered twice — as a desktop sidebar and inside the mobile
 * drawer — so it holds no state of its own; selection, renaming and deletion all
 * live in the route.
 *
 * The list is PAGED, not capped: `listSessions` returns one page plus a cursor,
 * and this is the only surface that can reach past the first one — there is no
 * search — so a session that falls off the rail has no other route back. Hence
 * "Load more" rather than a silent truncation.
 */
export type ChatSessionSummary = { id: string; title: string };

export function SessionRail({
  sessions,
  selectedId,
  pending,
  creating,
  hasMore,
  loadingMore,
  loadMoreError,
  onSelect,
  onCreate,
  onLoadMore,
  onRename,
  onDelete,
}: {
  sessions: ChatSessionSummary[];
  selectedId?: string;
  pending: boolean;
  creating: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  loadMoreError: boolean;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onLoadMore: () => void;
  onRename: (session: ChatSessionSummary) => void;
  onDelete: (session: ChatSessionSummary) => void;
}) {
  const { t } = useTranslation(["chat"]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b p-3">
        <Button className="min-h-[44px] w-full" onClick={onCreate} disabled={creating}>
          <Plus className="size-4" aria-hidden="true" />
          {t("chat:sessions.new")}
        </Button>
      </div>
      <div className="min-h-0 min-w-0 flex-1 space-y-1 overflow-y-auto overflow-x-clip overscroll-contain p-2">
        {pending ? (
          <div className="space-y-1 p-1">
            <Skeleton className="h-11 w-full rounded-md" />
            <Skeleton className="h-11 w-full rounded-md" />
            <Skeleton className="h-11 w-full rounded-md" />
          </div>
        ) : sessions.length === 0 ? (
          <p className="p-3 text-sm text-muted-foreground">{t("chat:sessions.empty")}</p>
        ) : (
          sessions.map((session) => {
            // An empty title is the stored "unset" sentinel — the words for it
            // are owned by the locale bundle, never by the database. Resolved
            // once here because the menu's labels need the same name the row
            // shows, and the delete confirmation makes the user type it.
            const label = session.title || t("chat:sessions.untitled");
            return (
              <div key={session.id} className="flex items-center gap-1">
                <Button
                  variant={selectedId === session.id ? "secondary" : "ghost"}
                  className="min-h-[44px] min-w-0 flex-1 justify-start"
                  aria-current={selectedId === session.id ? "true" : undefined}
                  onClick={() => onSelect(session.id)}
                >
                  <span className="truncate">{label}</span>
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <Button
                        variant="ghost"
                        size="icon"
                        className="min-h-[44px] min-w-[44px] shrink-0"
                        // Named after the conversation, not just "options": a
                        // screen-reader user hearing a rail of identical
                        // "Conversation options" buttons cannot tell which row
                        // they are on.
                        aria-label={t("chat:sessions.menu", { name: label })}
                      />
                    }
                  >
                    <MoreVertical className="size-4" aria-hidden="true" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => onRename(session)}>
                      <Pencil className="size-4" aria-hidden="true" />
                      {t("chat:actions.rename")}
                    </DropdownMenuItem>
                    <DropdownMenuItem variant="destructive" onClick={() => onDelete(session)}>
                      <Trash2 className="size-4" aria-hidden="true" />
                      {t("chat:actions.delete")}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            );
          })
        )}
        {/* The next page: a skeleton row shaped like the entries it will become
            while it loads, an inline retry if it failed — never a dead end,
            because these conversations are unreachable any other way. */}
        {!pending && hasMore ? (
          loadingMore ? (
            <Skeleton className="h-11 w-full rounded-md" />
          ) : loadMoreError ? (
            <InlineRetry
              className="py-4"
              message={t("chat:errors.moreSessions")}
              onRetry={onLoadMore}
            />
          ) : (
            <Button variant="ghost" className="min-h-[44px] w-full" onClick={onLoadMore}>
              {t("chat:sessions.loadMore")}
            </Button>
          )
        ) : null}
      </div>
    </div>
  );
}
