import { Button } from "@starter/ui/components/button";
import { Skeleton } from "@starter/ui/components/skeleton";
import { ArrowDownToLine } from "lucide-react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { InlineRetry } from "@/components/inline-retry";
import type { ChatMessage } from "@/hooks/use-chat-stream";
import { useStickToBottom } from "@/hooks/use-stick-to-bottom";
import { MessageParts } from "./message-parts";

/**
 * Cheap change signal for the transcript — what `useStickToBottom` watches to
 * know there is new activity (re-pin a following reader, flag unseen content
 * otherwise).
 *
 * O(messages × parts), never O(chars): per message it records seq, part count,
 * and the total length of the parts' string fields — never the text itself.
 * Streamed tokens coalesce into ONE growing text part (see use-chat-stream),
 * so the length term is what moves per token; a part add/remove moves the
 * count term. The only change this misses is a same-length text swap, which
 * cannot move the scroll position anyway.
 */
export function chatActivityKey(messages: ChatMessage[]): string {
  return messages
    .map((message) => {
      let size = 0;
      for (const part of message.parts) {
        for (const value of Object.values(part)) {
          if (typeof value === "string") size += value.length;
        }
      }
      return `${message.seq}:${message.parts.length}:${size}`;
    })
    .join("|");
}

export function MessageList({
  messages,
  pending,
  sessionId,
  turnStart,
  hasOlder,
  loadingOlder,
  loadOlderError,
  onLoadOlder,
}: {
  messages: ChatMessage[];
  pending: boolean;
  sessionId: string | undefined;
  /** Incremented by the caller on every send so the new question re-anchors. */
  turnStart: number;
  /** Is there a page of older messages left to fetch? */
  hasOlder: boolean;
  loadingOlder: boolean;
  loadOlderError: boolean;
  onLoadOlder: () => void;
}) {
  const { t } = useTranslation(["chat"]);
  const activityKey = useMemo(() => chatActivityKey(messages), [messages]);
  const scroll = useStickToBottom(activityKey, sessionId, turnStart);

  if (pending)
    return (
      <div className="space-y-4 p-4">
        <Skeleton className="ml-auto h-16 w-2/3 rounded-lg" />
        <Skeleton className="h-28 w-4/5 rounded-lg" />
        <Skeleton className="ml-auto h-12 w-1/2 rounded-lg" />
      </div>
    );

  // Rendered as the FIRST child of the scroll container, above the oldest
  // message — the transcript's live edge is its bottom, so the only direction
  // that can grow without disturbing the reader is upward. Nothing here calls
  // into `useStickToBottom`: prepending content leaves `following` false for a
  // reader who scrolled up to reach this control, so the viewport stays put and
  // the browser's own scroll anchoring keeps the same message under the cursor.
  const older =
    !hasOlder || messages.length === 0 ? null : loadingOlder ? (
      <Skeleton className="h-20 w-4/5 rounded-lg" />
    ) : loadOlderError ? (
      <InlineRetry
        className="py-4"
        message={t("chat:errors.olderMessages")}
        onRetry={onLoadOlder}
      />
    ) : (
      <Button variant="ghost" className="min-h-[44px] w-full" onClick={onLoadOlder}>
        {t("chat:messages.loadOlder")}
      </Button>
    );

  if (messages.length === 0)
    return (
      <div className="flex h-full flex-1 items-center justify-center p-8 text-center text-sm text-muted-foreground">
        {t("chat:messages.empty")}
      </div>
    );

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <div
        ref={scroll.containerRef}
        onScroll={scroll.onScroll}
        onPointerDownCapture={scroll.pauseFollowing}
        onKeyDownCapture={scroll.pauseFollowing}
        onSelectCapture={scroll.pauseFollowing}
        className="min-h-0 min-w-0 flex-1 space-y-4 overflow-y-auto overflow-x-clip overscroll-contain p-4 [scrollbar-gutter:stable]"
        aria-label={t("chat:messages.transcript")}
      >
        {older}
        {messages.map((message) => (
          <article
            key={message.seq}
            // Read back by useStickToBottom to anchor on the latest question.
            data-chat-role={message.role}
            className={`max-w-[88%] rounded-lg px-4 py-3 text-sm leading-relaxed ${
              message.role === "USER" ? "ml-auto bg-primary text-primary-foreground" : "bg-muted"
            }`}
          >
            <MessageParts parts={message.parts} />
          </article>
        ))}
      </div>
      <p className="sr-only" aria-live="polite">
        {scroll.hasUnseenActivity ? t("chat:status.running") : ""}
      </p>
      {!scroll.following && scroll.hasUnseenActivity ? (
        <button
          type="button"
          onClick={() => scroll.setFollowing(true)}
          className="absolute inset-x-4 bottom-3 flex min-h-[44px] items-center justify-center gap-2 rounded-md border bg-background/95 px-3 text-sm shadow-sm backdrop-blur"
        >
          <ArrowDownToLine className="size-4" aria-hidden="true" />
          {t("chat:messages.jumpToLatest")}
        </button>
      ) : null}
    </div>
  );
}
