# Payments / billing (recipe — not shipped)

The template ships **no payments code**, on purpose: a billing integration is a standing credential surface, a webhook endpoint that can create money-state, and a class of bug (double-charges, ghost subscriptions) that you cannot see in review. That is exactly the category this repo routes through add-in-style recipes instead of shipped code ([add-ins/api-keys.md](./add-ins/api-keys.md) is the precedent). This doc is the recipe; the decisions are the developer's, not yours — treat every section here as questions to bring back, not defaults to pick silently.

## Decisions before any code

1. **What is being sold?** One-time purchases, subscriptions, or usage metering. Each has a different schema; don't build all three.
2. **Provider.** Stripe is the default answer for small businesses (open-source alternative with the same shape: killbill for self-hosted). The recipe below is provider-neutral; the concrete examples say Stripe.
3. **What does paying change?** The entitlement question: which role, flag, limit, or feature flips when payment succeeds — and where is that recorded? This is an access-matrix row ([getting-started](./getting-started.md)); mark it ⚠️ (money moves) and say how it's enforced.
4. **Refund and dispute policy.** Decide with the developer before the first charge, write it in the notes, and implement it as data (status transitions), not deletes.

## Non-negotiable rules

- **Money is integer minor units.** `priceCents` / `amountMinor` + an explicit `currency` column; never `Float`. [schema-guidelines § Money — never floating point](./schema-guidelines.md#money--never-floating-point).
- **The server owns prices.** The client sends *what* to buy (product id, quantity), never *how much to charge*. Look the amount up from your own records at checkout-session creation. A client-provided amount is the classic "pay $1 for a $400 item" bug.
- **Webhooks are the source of truth.** The checkout page returning is a UI event, not a payment event. Entitlements flip when the signed webhook says they flip (with the client polling as UX sugar at most).
- **Every webhook event is stored before it is acted on**, keyed uniquely on the provider's event id, so replays (Stripe retries, and you *will* see retries) are idempotent. Process-then-store double-charges on the retry.
- **Never delete or mutate money rows.** Status transitions append (`PaymentIntent` → `succeeded` is a new state on the same row; refunds are new rows referencing the original).

## Subscription disclosures and cancellation

Before taking a subscription payment, complete [launch-readiness](./launch-readiness.md). Display price/currency, interval, trial conversion, renewal, and cancellation terms clearly beside the purchase consent; obtain affirmative consent and send a confirmation with terms and cancellation instructions. Never infer renewal consent from a generic terms link or a prechecked box.

Use the hosted customer portal, but verify its deployed configuration allows online cancellation for the sold plan and make that path easy to find in app settings. Test cancellation through the provider webhook, including retries and the resulting access end date. Cancelling renewal, issuing a refund, and deleting the account are different actions. Applicable reminders, disclosures, and cancellation rules depend on launch regions; resolve them with the owner before enabling recurring charges.

## Schema sketch

```prisma
model Order {
  id          String   @id @default(cuid())
  userId      String
  user        User     @relation(fields: [userId], references: [id])
  productKey  String            // what was bought — your product table's key
  amountMinor Int               // snapshot at purchase time; the product's
  currency    String            //   price can change later, the order can't
  status      OrderStatus       // PENDING / PAID / REFUNDED / FAILED
  providerId  String?  @unique  // the provider's object id (checkout session)
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
}

model WebhookEvent {
  id          String   @id @default(cuid())
  provider    String
  eventId     String            // provider's unique event id
  type        String
  payloadJson String            // raw, as received
  receivedAt  DateTime @default(now())
  processedAt DateTime?

  @@unique([provider, eventId]) // the idempotency fence
}
```

Required-field and naming conventions per [schema-guidelines](./schema-guidelines.md). Add an entitlement model only if the answer to decision 3 isn't derivable from `Order` rows.

## The webhook endpoint

- **A dedicated Hono route** (e.g. `/api/webhooks/stripe`), mounted in `apps/server/src/index.ts` — not an oRPC procedure. It has no session; its auth is the signature.
- **Verify the signature on the raw body before parsing.** Use the provider's official verification (Stripe: `constructEvent(rawBody, sigHeader, secret)` with the raw request bytes — not a re-serialized parse). Reject verification failures with 400 and no processing.
- **Respond fast, process in the queue.** Persist the `WebhookEvent` row, enqueue a handler, return 200. Providers that see slow responses retry aggressively and then disable the endpoint; a DB + mail + entitlement update chain does not belong in the request. [queue](./queue.md).
- **Rate limiting / access:** a webhook route is not a browser surface — signature verification *is* the gate; do not put it behind the public IP limiter families. Do keep it unauthenticated-by-cookie (it will never carry one).
- **Replay is normal.** If `(provider, eventId)` already exists with `processedAt` set, return 200 immediately. If it exists unprocessed, the queue job will handle it — don't process inline.

## Secrets and env

Provider keys are secrets like any other — the two-file change: `packages/env/src/vars/server.ts` (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`) + `scripts/lib/env-manifest.ts`, then `pnpm env:sync` ([environment-variables](./environment-variables.md)). Never a test-mode and live-mode key in the same env. Webhook signing secrets are per-endpoint — changing the URL means rotating the secret.

## Client flow: prefer the hosted checkout

For the simplicity goal, **redirect to the provider's hosted checkout page** (Stripe Checkout) over embedding payment fields or the provider's SDK components:

- PCI scope stays entirely with the provider — your forms never see card data, and the CSP doesn't grow provider script origins (do not loosen `apps/server/src/security-headers.ts` for an embedded SDK without making that an explicit, reviewed decision).
- One server procedure creates the checkout session (with the server-looked-up amount), returns the redirect URL; a `success` return URL lands the user on a "thank you" page that polls entitlement state — the webhook remains what actually flips it.
- Subscriptions: use the provider's customer portal for cancel/upgrade/card-change. Building your own card-management UI is the single largest waste in first-pass billing.

## Failure modes to design for (and test)

- **The double webhook** — same event delivered twice: covered by the unique fence.
- **The out-of-order pair** — `checkout.completed` arriving after you've marked the order failed by timeout: flip forward on provider truth, never backward from local timeouts.
- **The refund you didn't model** — refunding in the provider dashboard while your app knows nothing: reconcile (a nightly queue job listing provider events / or at minimum the admin ability to trigger a re-sync) rather than assuming webhooks are the only write path.
- **The amount snapshot drift** — product price changed between checkout creation and webhook: the `Order.amountMinor` snapshot is the truth for what was owed; the entitlement follows the *product*, the accounting follows the *order*.

Test with the provider's CLI (Stripe CLI forwards signed test events to localhost), signature-failure fixtures, and replay fixtures. Mock the provider in unit tests; never live keys in dev — dev `.env` files hold disposable credentials only ([environment-variables § Agent notes](./environment-variables.md#agent-notes)).

## Anti-patterns

- Storing card data, ever, in any form — that's the provider's job, and the compliance cliff is vertical.
- Entitlement derived from "did the checkout page come back" — the return URL is reachable by anyone who can type.
- `Float` for amounts, or amounts without a currency column.
- A `billings` router with no access-matrix rows — money surfaces are the definition of ⚠️.
