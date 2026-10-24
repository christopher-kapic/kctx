import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Scroll anchoring for a streaming transcript.
 *
 * Two behaviours that a naive "scroll to bottom on every update" gets wrong:
 *   * Following is OPT-IN and is dropped the moment the reader interacts. A
 *     stream that yanks the viewport back down while someone is reading an
 *     earlier answer is the single worst chat-UI bug, so pointer/key/select
 *     capture events pause it and only reaching the live edge resumes it.
 *   * A new turn scrolls the reader's own message to the TOP of the viewport,
 *     not the bottom of the container — that is what keeps the question visible
 *     while the answer grows underneath it.
 *
 * When not following, new activity sets `hasUnseenActivity` so the caller can
 * offer a "jump to latest" affordance instead of moving the viewport.
 *
 * BOTH OUTPUTS ARE DERIVED FROM ONE ANCHOR. The anchor records what the reader
 * has actually seen — which session/turn they are parked on, whether they are
 * riding the live edge, and the content they had in front of them at that
 * moment — and is written only from the events that change it (a scroll, a
 * "jump to latest" tap, landing on a new question). Opening another session or
 * starting another turn therefore does not have to *reset* anything: the anchor
 * simply stops matching, and `following` / `hasUnseenActivity` read false for
 * the new one until it is re-established. No adjustment effect, so no render
 * ever shows the previous turn's scroll state.
 */

const BOTTOM_SLACK_PX = 48;

/**
 * `key` scopes the anchor to one question in one session; `seenKey` is the
 * `activityKey` that was on screen when the anchor was last established, so
 * anything newer is by definition unseen.
 */
type Anchor = { key: string; following: boolean; seenKey: string };

export function useStickToBottom(
  /** Changes whenever rendered content changes — the signal that there is new activity. */
  activityKey: string,
  sessionId: string | undefined,
  /** Incremented by the caller on each send; re-anchors on the new question. */
  turnStart: number,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const restoredSession = useRef<string | undefined>(undefined);
  const handledTurnStart = useRef(turnStart);
  const anchorKey = `${sessionId ?? ""}:${turnStart}`;
  const [anchor, setAnchor] = useState<Anchor>(() => ({
    key: anchorKey,
    following: false,
    seenKey: activityKey,
  }));

  const current = anchor.key === anchorKey ? anchor : undefined;
  const following = current?.following === true;
  // Following means the reader is already looking at the live edge, so there is
  // nothing unseen by construction. Before the anchor is established for this
  // turn there is nothing to have missed either.
  const hasUnseenActivity = current !== undefined && !following && current.seenKey !== activityKey;

  const scrollToLatest = useCallback(() => {
    const element = containerRef.current;
    if (element) element.scrollTo({ top: element.scrollHeight });
  }, []);

  const setFollowing = useCallback(
    (next: boolean) => {
      setAnchor((previous) => {
        // Pausing while already paused is a no-op: a reader who touches the
        // transcript must not lose the "jump to latest" affordance they were
        // about to reach for.
        if (!next && previous.key === anchorKey && !previous.following) return previous;
        return { key: anchorKey, following: next, seenKey: activityKey };
      });
      if (next) scrollToLatest();
    },
    [activityKey, anchorKey, scrollToLatest],
  );

  const onScroll = useCallback(() => {
    const element = containerRef.current;
    if (!element) return;
    const atLiveEdge =
      element.scrollHeight - element.scrollTop - element.clientHeight < BOTTOM_SLACK_PX;
    setAnchor((previous) => {
      if (previous.key === anchorKey && previous.following === atLiveEdge) return previous;
      // Whichever way it flipped, the reader has just seen the current content:
      // arriving at the live edge shows it, and leaving it means they were being
      // scrolled along with it until this moment.
      return { key: anchorKey, following: atLiveEdge, seenKey: activityKey };
    });
  }, [activityKey, anchorKey]);

  const pauseFollowing = useCallback(() => setFollowing(false), [setFollowing]);

  // Opening a session lands on its last question rather than the very bottom, so
  // a long final answer starts where it started, not where it ended; a brand-new
  // turn in the session already open anchors the same way. Both re-run until the
  // question is actually in the DOM, which is why the refs commit only once a
  // target was found. The state write records the anchor these props describe —
  // it is not a reset, because the derivation above already reads false for an
  // anchor that no longer matches.
  useEffect(() => {
    if (restoredSession.current === sessionId && handledTurnStart.current === turnStart) return;
    const target = [
      ...(containerRef.current?.querySelectorAll<HTMLElement>('[data-chat-role="USER"]') ?? []),
    ].at(-1);
    if (!target) return;
    restoredSession.current = sessionId;
    handledTurnStart.current = turnStart;
    setAnchor({ key: anchorKey, following: false, seenKey: activityKey });
    target.scrollIntoView({ block: "start" });
  }, [activityKey, anchorKey, sessionId, turnStart]);

  // The only thing new content still has to do imperatively: keep a reader who
  // is riding the live edge pinned to it. Whether anyone else missed something
  // is answered by `hasUnseenActivity` during render.
  // biome-ignore lint/correctness/useExhaustiveDependencies: activityKey is an intentional re-run trigger — each new bit of activity must re-pin a following reader to the live edge, even though the effect body doesn't read it directly.
  useEffect(() => {
    if (following) scrollToLatest();
  }, [activityKey, following, scrollToLatest]);

  return {
    containerRef,
    following,
    hasUnseenActivity,
    onScroll,
    pauseFollowing,
    setFollowing,
  };
}
