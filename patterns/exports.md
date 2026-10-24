# Exports (CSV downloads, then PDF)

"Export this table as a spreadsheet" and "give me this invoice as a PDF" are routine small-business asks, and both are easy to do badly: an unbounded query that reads the whole table into memory, a CSV that breaks on the first comma or emoji in the data, or a PDF library that drags headless Chromium into the container. This is the recipe for both, in order of frequency.

## CSV: pick the right size tier first

Ask (or measure) how many rows the export will have. The two tiers have different shapes:

### Tier 1 — small exports (< ~5,000 rows): build client-side from existing procedures

Do not add a server route. The list procedure you are exporting already exists, is bounded, paginated, and permission-checked — reuse it:

1. Page through it with TanStack Query (`.infiniteOptions()` + `fetchNextPage`, the same shape `<LoadMore>` uses — [data-fetching](./data-fetching.md)).
2. Build the CSV in the browser from the accumulated pages and hand it to the user via a Blob URL + `URL.createObjectURL` + a temporary `<a download>` click.
3. Escape every cell: wrap in quotes, double any embedded quotes, and prefix cells starting with `=`, `+`, `-`, or `@` with a `'` — that is the CSV-injection guard (a cell like `=HYPERLINK(...)` executes in Excel otherwise).

This tier costs zero new server surface and zero new dependencies. Its failure mode is memory in the browser tab, which is why the row budget matters.

### Tier 2 — large exports: a dedicated streaming Hono route

Above the client-side budget, add a real download route. The shape, and why each piece is there:

- **A `GET` route under `apps/server/src/`, mounted in `index.ts` next to the asset routes** — not an oRPC procedure. oRPC returns JSON; a download needs `Content-Disposition: attachment` and a streamed body. Follow the session/auth conventions the other non-`/rpc` routes use; the route does its own permission check (same rule as the access matrix — decide in `notes/02-users-and-roles.md` who may export what, and mark PII-bearing exports ⚠️).
- **Stream, don't accumulate.** Set `Content-Type: text/csv; charset=utf-8`, write the header row, then walk the table with cursor pagination server-side — the same `cursorPageInput` / `take: pageTake(...)` primitives the list procedures use ([data-fetching](./data-fetching.md)), looping until a page comes back short. Emit `\r\n` line endings and quote-escape every cell as in Tier 1. Never build the whole file in a string first.
- **A BOM (`\uFEFF`) as the first bytes** if your users open the file in Excel with non-ASCII data (accents, any localized text) — without it Excel guesses the encoding and mangles it.
- **Rate limit it as its own surface.** An export costs one request per N thousand rows — give the route its own bucket rather than letting it eat the shared RPC budget ([rate-limiting § Give every surface its own bucket](./rate-limiting.md#give-every-surface-its-own-bucket)).
- **Header row language.** The server does not have the web app's i18next instance. Either export canonical field keys (fine for data going into other tools), or pass `?lang=` and read labels from a small server-side map. Pick one and say which in the route's comment — do not silently mix.

If exports can grow unbounded (orders, audit logs), the queue is the honest tier 3: a BullMQ job writes the file to S3 and emails a link ([assets](./assets.md) for the URL permission rules — an emailed export URL is a bearer token for 24 h). Do not build tier 3 until a real export has actually timed out.

## PDF: server-side, one vetted library, no Chromium

The temptation is "render my React component to PDF" — which means a headless browser in the container: hundreds of MB, a fonts/sandbox minefield, and the exact class of image bloat this template refuses elsewhere. Don't.

- **Use a declarative PDF library** — [`pdf-lib`](https://github.com/Hopding/pdf-lib) for programmatic documents (invoices, receipts, tickets) or [`@react-pdf/renderer`](https://github.com/diegomura/react-pdf) if you want component-shaped code without a browser. Both are open-source, dependency-light, and run in plain Node. Confirm the dependency with the developer first and pin it in the pnpm catalog ([agent-tooling § Installing a new pnpm package](./agent-tooling.md#installing-a-new-pnpm-package)).
- **Fonts**: PDF text needs embedded font files. The repo already ships OFL-licensed Roboto for the web — reuse those font files rather than adding a new family, and keep the license note in [THIRD-PARTY-LICENSES.md](../THIRD-PARTY-LICENSES.md) current.
- **Money**: format from your integer minor units with `Intl.NumberFormat` at render time; never let a float touch an amount ([schema-guidelines § Money — never floating point](./schema-guidelines.md#money--never-floating-point)).
- **Locale**: invoice PDFs are user-facing strings — take the user's locale (from the URL segment or the record) and lay out labels from the same locale bundles, not hardcoded English ([i18n](./i18n.md)).
- **Where it runs**: small PDFs (an invoice) can render in the request handler and stream as `application/pdf`. Anything heavier (a report over thousands of rows) belongs in the queue like a tier-3 export.

## Anti-patterns

- `findMany` without `take` to "get everything for the export" — the policy gate will (correctly) flag it; bound the walk.
- Client-side `window.print()` as "the PDF export" — fine as a shortcut for internal pages, not for customer-facing documents.
- Export routes that skip the permission check because "the UI only links to it for admins" — the URL is the API.
