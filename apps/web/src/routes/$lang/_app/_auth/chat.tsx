import { Button } from "@starter/ui/components/button";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from "@starter/ui/components/drawer";
import { Skeleton } from "@starter/ui/components/skeleton";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Menu } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { ChatComposer } from "@/components/chat/composer";
import { MessageList } from "@/components/chat/message-list";
import { RenameSessionSheet } from "@/components/chat/rename-session-sheet";
import { type ChatSessionSummary, SessionRail } from "@/components/chat/session-rail";
import { ConfirmDeleteDialog } from "@/components/confirm-delete-dialog";
import { InlineRetry } from "@/components/inline-retry";
import { type ChatMessage, useChatStream } from "@/hooks/use-chat-stream";
import { flattenMessagePages } from "@/lib/chat-messages";
import { flattenSessionPages } from "@/lib/chat-sessions";
import { orpc } from "@/utils/orpc";

/**
 * Durable agentic chat. The transcript is fetched once through oRPC and then
 * kept current by the SSE stream in `useChatStream`; the two agree because both
 * are keyed on the same per-session `seq`. See patterns/add-ins/chat.md.
 */
export const Route = createFileRoute("/$lang/_app/_auth/chat")({
  component: ChatPage,
});

function ChatPage() {
  const { t } = useTranslation(["chat"]);
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<string>();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [turnStart, setTurnStart] = useState(0);
  // The session each overlay is acting on, captured at open time rather than
  // read from `selectedId`: both are reachable from any row in the rail, not
  // only the one currently open in the transcript pane.
  const [renaming, setRenaming] = useState<ChatSessionSummary>();
  const [deleting, setDeleting] = useState<ChatSessionSummary>();

  // Paged, not a single page: the rail is the only way to open an older
  // conversation — the page has no search and no delete — so ignoring
  // `nextCursor` would make every session past the first page unreachable.
  const {
    data: sessionsData,
    isPending: sessionsPending,
    isError: sessionsError,
    refetch: refetchSessions,
    fetchNextPage: fetchMoreSessions,
    hasNextPage: hasMoreSessions,
    isFetchingNextPage: loadingMoreSessions,
  } = useInfiniteQuery(
    orpc.chat.listSessions.infiniteOptions({
      input: (cursor: string | undefined) => ({ cursor }),
      initialPageParam: undefined as string | undefined,
      getNextPageParam: (lastPage) => lastPage.nextCursor,
    }),
  );
  const sessions = useMemo(() => flattenSessionPages(sessionsData?.pages), [sessionsData?.pages]);
  // Falling back to the newest session means a returning visitor lands in the
  // conversation they left rather than on an empty pane.
  const selectedId = selected ?? sessions[0]?.id;
  // Whether this deployment can serve chat at all: `CHAT_ENABLED` and an
  // `OPENROUTER_API_KEY`. The procedures refuse regardless — this query only
  // decides whether the page offers a composer or explains itself.
  const { data: chatConfig, isPending: configPending } = useQuery(orpc.chat.config.queryOptions());
  const { data: sessionData } = useQuery({
    ...orpc.chat.getSession.queryOptions({ input: { id: selectedId ?? "" } }),
    enabled: Boolean(selectedId),
  });
  // Paged, and paged BACKWARDS: `listMessages` returns the newest page first and
  // "Load older" walks toward the start of the conversation. A single un-paged
  // query silently capped the transcript at the procedure's default page size —
  // and because the page was taken from the *oldest* end, everything past it was
  // unreachable, including the user's own newest turns (the SSE stream never
  // publishes those). `hydratedCursor` still resolves across every loaded page,
  // so the replay cursor tracks the highest COMPLETE row the client holds.
  const {
    data: messagesData,
    isPending: messagesPending,
    isError: messagesError,
    refetch: refetchMessages,
    fetchNextPage: fetchOlderMessages,
    hasNextPage: hasOlderMessages,
    isFetchingNextPage: loadingOlderMessages,
  } = useInfiniteQuery({
    ...orpc.chat.listMessages.infiniteOptions({
      input: (cursor: number | undefined) => ({ sessionId: selectedId ?? "", cursor }),
      initialPageParam: undefined as number | undefined,
      getNextPageParam: (lastPage) => lastPage.nextCursor,
    }),
    enabled: Boolean(selectedId),
  });
  const hydrated = useMemo<ChatMessage[]>(
    () =>
      flattenMessagePages(messagesData?.pages).map((item) => ({
        id: item.id,
        seq: item.seq,
        role: item.role,
        // Carried through deliberately: only a COMPLETE row is a valid SSE
        // replay cursor, and `useChatStream` reads that off these rows. Dropping
        // it here would resume the stream from a half-written answer and never
        // receive its finished form. See patterns/durable-streaming.md.
        state: item.state,
        parts: Array.isArray(item.parts) ? (item.parts as ChatMessage["parts"]) : [],
      })),
    [messagesData?.pages],
  );
  // NOT `selectedId` directly — the stream must not open until the first
  // transcript page has landed. The replay cursor comes from `hydrated`, so
  // connecting while the query is still pending sends no cursor at all, and the
  // endpoint answers "no cursor" the only way it correctly can: by replaying the
  // session from message zero. That is right for a genuinely new reader and
  // wrong here — it re-sends a whole long conversation over SSE moments before
  // the paged query delivers the newest 50 anyway, defeating the paging on
  // exactly the sessions where paging matters. One page's latency buys a cursor.
  const stream = useChatStream(
    messagesPending ? undefined : selectedId,
    hydrated,
    sessionData?.status,
  );
  // Live status wins over the persisted one: the row is only rewritten when a
  // run ends, so mid-stream it still reads whatever it was before the send.
  const status = stream.status ?? sessionData?.status ?? "IDLE";

  const invalidateChat = async () => {
    await queryClient.invalidateQueries({ queryKey: orpc.chat.key() });
  };
  const createSession = useCreateSession({
    onCreated: (id) => {
      setSelected(id);
      setDrawerOpen(false);
    },
  });
  const send = useMutation({
    ...orpc.chat.send.mutationOptions({
      onSuccess: async () => {
        stream.markRunning();
        await invalidateChat();
        setTurnStart((value) => value + 1);
      },
    }),
    meta: { errorFallbackKey: "chat:errors.send" },
  });
  const retry = useMutation({
    ...orpc.chat.retry.mutationOptions({
      onSuccess: async () => {
        stream.markRunning();
        await invalidateChat();
      },
    }),
    meta: { errorFallbackKey: "chat:errors.retry" },
  });

  const selectSession = (id: string) => {
    setSelected(id);
    setDrawerOpen(false);
  };
  const rail = (
    <SessionRail
      sessions={sessions}
      selectedId={selectedId}
      pending={sessionsPending}
      creating={createSession.isPending}
      hasMore={hasMoreSessions}
      loadingMore={loadingMoreSessions}
      // A failed page is reported inside the rail, not as a whole-page error:
      // the sessions already listed are still usable.
      loadMoreError={sessionsError}
      onSelect={selectSession}
      onCreate={() => createSession.mutate({})}
      onLoadMore={() => void fetchMoreSessions()}
      onRename={(session) => {
        setDrawerOpen(false);
        setRenaming(session);
      }}
      onDelete={(session) => {
        setDrawerOpen(false);
        setDeleting(session);
      }}
    />
  );

  if (configPending || sessionsPending) return <ChatSkeleton />;
  // Deliberately BEFORE the sessions error branch: a server that cannot serve
  // chat has nothing useful to say about why the session list failed, and
  // offering "Try again" for a configuration problem is a dead end.
  if (chatConfig && !chatConfig.enabled) return <ChatUnavailable />;
  if (sessionsError && !sessionsData) {
    return (
      <InlineRetry
        className="py-16"
        message={t("chat:errors.sessions")}
        onRetry={() => refetchSessions()}
      />
    );
  }

  return (
    // Fills `main`'s fixed height track so the rail and the transcript scroll
    // in-pane instead of growing the page past the viewport. Opts out of the
    // shell's pull-to-refresh: the transcript owns its vertical gestures.
    <div
      data-pull-to-refresh="off"
      className="container mx-auto flex h-full min-h-0 max-w-6xl flex-col overflow-hidden px-4 py-4 md:py-6"
    >
      <div className="grid min-h-0 flex-1 overflow-hidden rounded-lg border bg-background shadow-sm md:grid-cols-[16rem_minmax(0,1fr)]">
        <aside className="hidden min-h-0 border-r md:block">{rail}</aside>
        <section className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
          <TranscriptHeader
            title={sessionData?.title}
            hasSession={Boolean(sessionData)}
            status={status}
            onOpenSessions={() => setDrawerOpen(true)}
          />
          <p className="shrink-0 border-b px-4 py-3 text-sm text-muted-foreground">
            {t("chat:disclosure")}
          </p>
          {!selectedId ? (
            <NoSessionState
              creating={createSession.isPending}
              onCreate={() => createSession.mutate({})}
            />
          ) : messagesError && !messagesData ? (
            // Only when there is nothing to show. Once a page has landed, a
            // failed *older* page is reported inside the transcript instead —
            // replacing a readable conversation with an error panel because the
            // page above it could not be fetched is the wrong trade.
            <InlineRetry
              className="flex-1 py-16"
              message={t("chat:errors.messages")}
              onRetry={() => refetchMessages()}
            />
          ) : (
            <>
              <div className="min-h-0 flex-1 overflow-hidden">
                <MessageList
                  messages={stream.messages}
                  pending={messagesPending}
                  sessionId={selectedId}
                  turnStart={turnStart}
                  // "Load older" sits at the TOP of the transcript, which is the
                  // only place it can go: a chat reads newest-at-the-bottom, so
                  // the end of the list is the live edge and must stay pinned
                  // there. Prepending never moves the viewport — `use-stick-to-
                  // bottom` only scrolls for a reader who is riding the live
                  // edge, and a reader who reached the top to press this is by
                  // definition not one.
                  hasOlder={hasOlderMessages}
                  loadingOlder={loadingOlderMessages}
                  // A failed older page is reported in place, not as a whole-page
                  // error: the transcript already on screen stays readable.
                  loadOlderError={messagesError}
                  onLoadOlder={() => void fetchOlderMessages()}
                />
              </div>
              <TranscriptNotices
                stream={stream}
                status={status}
                retrying={retry.isPending}
                onRetry={() => retry.mutate({ sessionId: selectedId })}
                onRefetchMessages={() => void refetchMessages()}
              />
              <div className="shrink-0">
                <ChatComposer
                  disabled={status === "RUNNING"}
                  sending={send.isPending}
                  onSend={async (text) => {
                    try {
                      await send.mutateAsync({ sessionId: selectedId, text });
                      return true;
                    } catch {
                      // Toasted by the global mutation-cache handler; returning
                      // false keeps the draft in the composer.
                      return false;
                    }
                  }}
                />
              </div>
            </>
          )}
        </section>
      </div>
      <Drawer open={drawerOpen} onOpenChange={setDrawerOpen} direction="left">
        <DrawerContent className="overscroll-contain">
          <DrawerHeader>
            <DrawerTitle>{t("chat:sessions.title")}</DrawerTitle>
            <DrawerDescription>{t("chat:sessions.description")}</DrawerDescription>
          </DrawerHeader>
          <div className="min-h-0 flex-1">{rail}</div>
        </DrawerContent>
      </Drawer>
      <SessionOverlays
        renaming={renaming}
        deleting={deleting}
        onDone={(action, session) => {
          if (action === "deleted" && session.id === selectedId) {
            // Only when the deleted session was the one on screen; `selectedId`
            // then falls back to the newest remaining conversation. Clearing it
            // unconditionally would kick a user out of the transcript they were
            // reading because they tidied up a different row in the rail.
            setSelected(undefined);
          }
          setRenaming(undefined);
          setDeleting(undefined);
        }}
      />
    </div>
  );
}

/**
 * The rename and delete overlays for one conversation, plus the mutations
 * behind them.
 *
 * Split out of `ChatPage` rather than exported: the route component keeps the
 * routing and query logic, and page regions become non-exported locals — see
 * patterns/react-composition.md. Which session each overlay acts on stays in
 * the route, because it is the rail (also rendered there) that chooses it.
 */
function SessionOverlays({
  renaming,
  deleting,
  onDone,
}: {
  renaming?: ChatSessionSummary;
  deleting?: ChatSessionSummary;
  onDone: (action: "renamed" | "deleted" | "dismissed", session: ChatSessionSummary) => void;
}) {
  const { t } = useTranslation(["chat"]);
  const queryClient = useQueryClient();
  const invalidateChat = async () => {
    await queryClient.invalidateQueries({ queryKey: orpc.chat.key() });
  };

  const renameSession = useMutation({
    ...orpc.chat.renameSession.mutationOptions({
      onSuccess: async () => {
        await invalidateChat();
      },
    }),
    meta: { errorFallbackKey: "chat:errors.rename" },
  });
  const deleteSession = useMutation({
    ...orpc.chat.deleteSession.mutationOptions({
      onSuccess: async (_result, variables) => {
        await invalidateChat();
        onDone("deleted", { id: variables.sessionId, title: "" });
      },
    }),
    meta: { errorFallbackKey: "chat:errors.delete" },
  });

  return (
    <>
      {/* Keyed on the session id so switching which conversation is being
          renamed remounts the form with the right default value — the
          reset-on-prop-change rule, not an effect. */}
      {renaming ? (
        <RenameSessionSheet
          key={renaming.id}
          open
          onOpenChange={(next) => {
            if (!next) onDone("dismissed", renaming);
          }}
          currentTitle={renaming.title}
          pending={renameSession.isPending}
          onRename={async (title) => {
            try {
              await renameSession.mutateAsync({ sessionId: renaming.id, title });
              onDone("renamed", renaming);
              return true;
            } catch {
              // Toasted by the global mutation-cache handler; returning false
              // keeps the sheet open with what the user typed.
              return false;
            }
          }}
        />
      ) : null}
      {deleting ? (
        <ConfirmDeleteDialog
          open
          onOpenChange={(next) => {
            if (!next) onDone("dismissed", deleting);
          }}
          title={t("chat:sessions.deleteTitle")}
          description={t("chat:sessions.deleteDescription")}
          // An untitled conversation stores "", which would make the token empty
          // and the confirm button permanently disabled. The localized
          // placeholder is what the row displays, so it is also what the user is
          // asked to type — and the copy button makes that one tap.
          confirmToken={deleting.title || t("chat:sessions.untitled")}
          typePrompt={t("chat:sessions.deleteTypePrompt")}
          copyAriaLabel={t("chat:sessions.deleteCopy")}
          isPending={deleteSession.isPending}
          onConfirm={() => deleteSession.mutate({ sessionId: deleting.id })}
        />
      ) : null}
    </>
  );
}

/**
 * Start a new conversation and select it.
 *
 * Its own hook because two places start one — the rail's button and the
 * empty-state button — and because `ChatPage` is at the size where every region
 * that can be lifted out should be.
 */
function useCreateSession({ onCreated }: { onCreated: (id: string) => void }) {
  const queryClient = useQueryClient();
  return useMutation(
    orpc.chat.createSession.mutationOptions({
      onSuccess: async (created) => {
        onCreated(created.id);
        await queryClient.invalidateQueries({ queryKey: orpc.chat.key() });
      },
    }),
  );
}

/** The transcript pane with no conversation selected — the first-run state. */
function NoSessionState({ creating, onCreate }: { creating: boolean; onCreate: () => void }) {
  const { t } = useTranslation(["chat"]);
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
      <p className="text-sm text-muted-foreground">{t("chat:sessions.empty")}</p>
      <Button className="min-h-[44px]" disabled={creating} onClick={onCreate}>
        {t("chat:sessions.new")}
      </Button>
    </div>
  );
}

/**
 * The transcript pane's title bar: the conversation's name, its live status, and
 * the mobile control that opens the session drawer.
 */
function TranscriptHeader({
  title,
  hasSession,
  status,
  onOpenSessions,
}: {
  title?: string;
  hasSession: boolean;
  status: string;
  onOpenSessions: () => void;
}) {
  const { t } = useTranslation(["chat"]);
  return (
    <header className="flex min-h-[56px] shrink-0 items-center gap-3 border-b px-3 md:px-4">
      <Button
        variant="ghost"
        size="icon"
        className="min-h-[44px] min-w-[44px] md:hidden"
        onClick={onOpenSessions}
        aria-label={t("chat:sessions.open")}
      >
        <Menu className="size-5" aria-hidden="true" />
      </Button>
      <div className="min-w-0 flex-1">
        <h1 className="truncate text-base font-semibold text-balance">
          {/* An untitled session stores "" — the locale bundle owns the
              placeholder wording, the database never does. */}
          {hasSession ? title || t("chat:sessions.untitled") : t("chat:title")}
        </h1>
        <p className="text-xs text-muted-foreground" aria-live="polite">
          {status === "RUNNING"
            ? t("chat:status.running")
            : status === "ERROR"
              ? t("chat:status.error")
              : t("chat:status.idle")}
        </p>
      </div>
    </header>
  );
}

/**
 * The strip of recoverable-state banners between the transcript and the
 * composer: a dropped stream, a run that has gone quiet, and a failed answer.
 *
 * All three are RECOVERY affordances rather than errors — each one names a
 * specific action that fixes it — which is why they live together and below the
 * transcript, where they cannot displace the conversation.
 */
function TranscriptNotices({
  stream,
  status,
  retrying,
  onRetry,
  onRefetchMessages,
}: {
  stream: ReturnType<typeof useChatStream>;
  status: string;
  retrying: boolean;
  onRetry: () => void;
  onRefetchMessages: () => void;
}) {
  const { t } = useTranslation(["chat"]);
  return (
    <>
      {/* The stream dropped. Reconnecting replays from the last `seq` seen, so
          nothing written while it was down is lost. */}
      {stream.connectionError ? (
        <ChatNotice
          message={t("chat:status.disconnected")}
          actionLabel={t("chat:actions.reconnect")}
          onAction={stream.reconnect}
        />
      ) : null}
      {/* "Stale" means the stream still says RUNNING but nothing has arrived for
          a long time — typically a terminal `status` frame published while
          nobody was subscribed, or never published because the worker died
          after committing. RECONNECTING is the load-bearing half of this
          recovery: the endpoint re-reads the session after its replay and emits
          the terminal status itself, which is the only path that can clear a
          stale RUNNING. Refetching messages alone leaves the stream's RUNNING
          status in place and the composer disabled forever. */}
      {stream.isStale ? (
        <ChatNotice
          message={t("chat:status.stale")}
          actionLabel={t("chat:actions.refresh")}
          onAction={() => {
            stream.reconnect();
            onRefetchMessages();
          }}
        />
      ) : null}
      {status === "ERROR" ? (
        <ChatNotice
          tone="destructive"
          message={t("chat:errors.response")}
          actionLabel={t("chat:actions.retry")}
          disabled={retrying}
          onAction={onRetry}
        />
      ) : null}
    </>
  );
}

function ChatNotice({
  message,
  actionLabel,
  onAction,
  disabled = false,
  tone = "muted",
}: {
  message: string;
  actionLabel: string;
  onAction: () => void;
  disabled?: boolean;
  tone?: "muted" | "destructive";
}) {
  return (
    <div
      className={`flex shrink-0 flex-wrap items-center justify-between gap-2 border-t px-4 py-2 text-sm ${
        tone === "destructive" ? "bg-destructive/5" : "bg-muted/40"
      }`}
    >
      <span>{message}</span>
      <Button
        variant="outline"
        size="sm"
        className="min-h-[44px]"
        disabled={disabled}
        onClick={onAction}
      >
        {actionLabel}
      </Button>
    </div>
  );
}

/**
 * The chat page on a deployment that is not configured for it.
 *
 * An explanation rather than an error: nothing has gone wrong and there is
 * nothing for the user to retry — the server was deployed without
 * `OPENROUTER_API_KEY`, or with `CHAT_ENABLED=false` because that key is there
 * only for translation runs. The composer is not rendered at all, so a turn
 * can never be started that the procedures would only refuse.
 */
function ChatUnavailable() {
  const { t } = useTranslation(["chat"]);
  return (
    <div className="container mx-auto flex h-full max-w-2xl flex-col items-center justify-center gap-3 px-4 text-center">
      <h1 className="text-lg font-semibold text-balance">{t("chat:unavailable.title")}</h1>
      <p className="text-sm text-muted-foreground text-balance">
        {t("chat:unavailable.description")}
      </p>
    </div>
  );
}

function ChatSkeleton() {
  return (
    <div className="container mx-auto grid h-full min-h-0 max-w-6xl gap-4 overflow-hidden px-4 py-4 md:grid-cols-[16rem_minmax(0,1fr)] md:py-6">
      <Skeleton className="hidden h-full min-h-0 rounded-lg md:block" />
      <Skeleton className="h-full min-h-0 rounded-lg" />
    </div>
  );
}
