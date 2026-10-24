/**
 * Session-rail paging helpers. See patterns/add-ins/chat.md.
 */

/**
 * Flatten the pages of `chat.listSessions` into the list the rail renders,
 * keeping the first occurrence of each id.
 *
 * The dedupe is not defensive noise. `listSessions` pages a cursor over
 * `[updatedAt desc, id desc]`, and that order is stable only for as long as the
 * rows are: every answered turn bumps its session's `updatedAt`, which moves the
 * row toward the head of the list. A session that sat on an unfetched page can
 * therefore reappear on a page already in the cache, and rendering the raw
 * concatenation would emit two React children with the same key. First
 * occurrence wins because pages are fetched head-first, so it is the newer
 * position.
 *
 * The reverse skew — a row sliding *past* the cursor and never being fetched —
 * is what the "Load more" control ultimately answers: the older rows stay
 * reachable because the list keeps paging, not because any single page is a
 * consistent snapshot.
 */
export function flattenSessionPages<Item extends { id: string }>(
  pages: readonly { items: Item[] }[] | undefined,
): Item[] {
  const seen = new Set<string>();
  const items: Item[] = [];
  for (const page of pages ?? []) {
    for (const item of page.items) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      items.push(item);
    }
  }
  return items;
}
