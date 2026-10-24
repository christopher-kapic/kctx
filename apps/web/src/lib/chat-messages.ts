/**
 * Transcript paging helpers. See patterns/add-ins/chat.md.
 */

/**
 * Flatten the pages of `chat.listMessages` into the transcript the page renders:
 * one ascending, duplicate-free list.
 *
 * `listMessages` pages BACKWARDS — page 0 is the newest `limit` rows, and each
 * further page is the `limit` rows below the previous page's lowest `seq`. Each
 * page is itself ascending, but the pages arrive newest-page-first, so a plain
 * concatenation would render the transcript in blocks of fifty played in
 * reverse. Sorting by `seq` is what puts it back together, and `seq` is a total
 * order per session, so the sort is exact rather than a best guess.
 *
 * The dedupe keeps the FIRST occurrence, which is the newest page's copy — the
 * one fetched against the most recent anchor, and therefore the one holding the
 * later `state` if a row was promoted from `STREAMING` to `COMPLETE` between two
 * fetches. It is cheap insurance rather than an everyday occurrence: the cursor
 * is a strict upper bound over an immutable key, so overlapping pages should not
 * arise. But the transcript keys its React children on `seq`, and a duplicate
 * key there is a hard failure, so the invariant is enforced here rather than
 * assumed.
 *
 * Note what this deliberately does NOT do: it does not try to detect a gap
 * between pages. There is none to detect — TanStack Query re-derives every page
 * param from `getNextPageParam` when it refetches an infinite query, so page 1's
 * anchor follows page 0's new lower edge instead of pointing at a boundary that
 * has since moved up. Rows appended while older pages are loaded stay covered.
 */
export function flattenMessagePages<Item extends { seq: number }>(
  pages: readonly { items: Item[] }[] | undefined,
): Item[] {
  const seen = new Set<number>();
  const items: Item[] = [];
  for (const page of pages ?? []) {
    for (const item of page.items) {
      if (seen.has(item.seq)) continue;
      seen.add(item.seq);
      items.push(item);
    }
  }
  return items.sort((left, right) => left.seq - right.seq);
}
