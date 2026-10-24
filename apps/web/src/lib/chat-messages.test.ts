import { describe, expect, it } from "vitest";

import { flattenMessagePages } from "./chat-messages";

const message = (seq: number, state = "COMPLETE") => ({ seq, state });

describe("flattenMessagePages", () => {
  it("returns an empty transcript before the first page arrives", () => {
    expect(flattenMessagePages(undefined)).toEqual([]);
  });

  // THE REGRESSION THIS HELPER EXISTS FOR. `listMessages` pages BACKWARDS: page
  // 0 is the newest rows and every later page is older. A plain concatenation
  // would render the transcript in blocks played in reverse — the newest fifty
  // messages above the fifty that precede them.
  it("orders the whole transcript ascending even though pages arrive newest-first", () => {
    const items = flattenMessagePages([
      { items: [message(4), message(5)] },
      { items: [message(2), message(3)] },
      { items: [message(0), message(1)] },
    ]);
    expect(items.map((item) => item.seq)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  // The transcript keys its React children on `seq`. Two pages can only overlap
  // if a boundary moved between fetches, but a duplicate key is a hard failure,
  // so the invariant is enforced rather than assumed — and the first occurrence
  // wins because it comes from the page anchored most recently, which holds the
  // later `state` when a row was promoted STREAMING → COMPLETE in between.
  it("keeps the newest page's copy when a row is reachable from two pages", () => {
    const items = flattenMessagePages([
      { items: [message(2, "COMPLETE"), message(3)] },
      { items: [message(1), message(2, "STREAMING")] },
    ]);
    expect(items.map((item) => item.seq)).toEqual([1, 2, 3]);
    expect(items[1]?.state).toBe("COMPLETE");
  });

  // `hydratedCursor` (use-chat-stream.ts) reduces over exactly this list to pick
  // the SSE replay cursor, and it must resolve to the highest COMPLETE seq
  // across EVERY loaded page. A flattener that dropped or reordered pages would
  // silently regress that cursor and make the stream replay from the wrong point.
  it("keeps every loaded page, so the replay cursor spans all of them", () => {
    const items = flattenMessagePages([
      { items: [message(8), message(9, "STREAMING")] },
      { items: [message(6), message(7)] },
    ]);
    expect(items.map((item) => item.seq)).toEqual([6, 7, 8, 9]);
    const highestComplete = items.reduce(
      (max, item) => (item.state === "COMPLETE" ? Math.max(max, item.seq) : max),
      -1,
    );
    expect(highestComplete).toBe(8);
  });
});
