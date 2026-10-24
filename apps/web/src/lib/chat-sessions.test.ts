import { describe, expect, it } from "vitest";

import { flattenSessionPages } from "./chat-sessions";

const session = (id: string, title = id) => ({ id, title });

describe("flattenSessionPages", () => {
  it("concatenates every fetched page, oldest last", () => {
    const items = flattenSessionPages([
      { items: [session("a"), session("b")] },
      { items: [session("c")] },
    ]);
    expect(items.map((item) => item.id)).toEqual(["a", "b", "c"]);
  });

  it("returns an empty list before the first page arrives", () => {
    expect(flattenSessionPages(undefined)).toEqual([]);
  });

  // `listSessions` orders by `updatedAt desc`, and answering in a session bumps
  // its `updatedAt`. A row from an unfetched page can therefore surface on a
  // page already in the cache; without the dedupe the rail renders two children
  // with the same React key.
  it("keeps the first occurrence when a session appears on two pages", () => {
    const items = flattenSessionPages([
      { items: [session("a", "renamed"), session("b")] },
      { items: [session("b"), session("c")] },
    ]);
    expect(items.map((item) => item.id)).toEqual(["a", "b", "c"]);
    expect(items[1]?.title).toBe("b");
  });
});
