# Rate Limiting

Rate limits stop abuse — credential stuffing, signup spam, mail floods, scraping — by capping how many requests one caller can make in a window. This app ships them already wired. You mostly need this doc for two things: **adding a limiter when you add a new surface**, and **understanding why a limit that looks "safer" when you lower it is often the opposite**.

Everything lives in `apps/server/src/rate-limit.ts`, is backed by Redis, and is tuned with five named budgets — `RATE_LIMIT_{AUTH,RPC,UPLOAD,EMAIL,CHAT}_POINTS` + `_WINDOW_SECONDS` — that each scale a whole *family* of limiters coherently (see "The five budgets" below). One exception, and it is documented there too: a limiter that guards an **oRPC procedure** rather than a route cannot be Hono middleware, so it sits beside its procedures — see "When the surface is a procedure, not a route".

## The one-paragraph version

There are two kinds of limiter here. **Strict** limiters guard credentials and outbound mail; they are small numbers and they *fail closed* (if Redis is down, requests are refused). **General** limiters guard ordinary traffic; they are large numbers and they *fail open* (if Redis is down, requests are allowed, with a relaxed in-memory backstop). Each surface gets its own bucket. When you add a route that can be hit hard, give it a limiter from the right family and pick the budget by counting how many requests **one legitimate user action** costs.

## The five budgets

The env surface is five named budgets, two knobs each — deliberately not one knob per limiter. A per-surface knob invites squeezing one budget to "be safe" (locking out a shared office behind one NAT IP) instead of *splitting the surface* that needs its own bucket. Family scaling keeps every member's designed ratio intact when you retune:

- `RATE_LIMIT_<FAMILY>_POINTS` multiplies every member's points by `provided / reference`.
- `RATE_LIMIT_<FAMILY>_WINDOW_SECONDS` multiplies every member's window **and block duration** by the same factor — the window:block ratio is part of each member's design and moves as a unit.

| Budget | Reference member (default) | Other members (code ratios) |
|---|---|---|
| `RATE_LIMIT_AUTH_*` | general `/api/auth/*` — 30 / 60 s, 5-min block | credential 10/60 s (5-min block) · credential-burst 3/10 s · signup 10/h (15-min block) · 2FA-OTP 3/15 min |
| `RATE_LIMIT_RPC_*` | `/rpc/*` — 100 / 60 s | `/ready` 60 · SSR catch-all 300 |
| `RATE_LIMIT_UPLOAD_*` | `/api/assets/*` — 200 / 60 s | images 300 |
| `RATE_LIMIT_EMAIL_*` | resend/reset per recipient — 3 / hour | signup 6/h · sign-in mails 10/h · **0 disables all three** |
| `RATE_LIMIT_CHAT_*` | `chat.send`/`chat.retry` — 20 turns / 60 s, fail-closed | session creation 30 · SSE stream 60 |

Setting `RATE_LIMIT_AUTH_POINTS=60` therefore doubles the credential (10→20), burst (3→6), signup (10→20) and 2FA-OTP (3→6) budgets along with the reference — one decision, re-tunes the family. What deliberately does **not** become env-tunable: burst/sustained ratios, bucket keying, fail-open vs fail-closed, and the code-fixed 0-second block on the recipient limiters (a block on a caller-supplied key is an unauthenticated lockout lever). The failed-sign-in triple is code-only for the same reason — see "The per-account layer" below. The math lives in `packages/api/src/lib/rate-limit-families.ts`; the members are wired in `apps/server/src/rate-limit.ts` and `packages/api/src/lib/chat-rate-limit.ts`.

## The mistake this file exists to prevent

> **A tighter limit is not a safer limit.**

Every limiter here except the mail ones keys on the caller's **IP address**. Offices, schools, campus wifi, coworking spaces, and mobile carriers put hundreds of people behind a single address. A limit tuned as though one IP equals one person locks out everyone at that location — and it locks them out of the recovery flows too.

The template previously shipped `authLimiter` at 10 requests per 60 seconds with a **15-minute** block, across all of `/api/auth/*`. A sign-in with 2FA is 4-5 requests. So the third person to log in from one office was locked out of sign-in, password reset, *and* email verification for 15 minutes, with no way to tell why. That is a self-inflicted outage wearing a security costume.

The fix is not a bigger number everywhere. It is **splitting the surface** so the tight limit only covers the endpoints where a guess is worth something:

| Endpoints | Limiter | Budget | Why |
|---|---|---|---|
| `/api/auth/sign-in/*`, `/api/auth/two-factor/*` | `credentialLimiter` | 10 / 60 s, 5-min block | A guess here is an attempt at someone's account. Keep it tight. |
| The rest of `/api/auth/*` | `authLimiter` | 30 / 60 s, 5-min block | Password reset and verification. Locking these out punishes the victim. |
| `/api/auth/sign-up/*` | `signupLimiter` | 10 / hour, 15-min block | See "the limiter that actually works" below. |

## Two things a rate limiter cannot do

**1. An IP limiter cannot bound how much mail one mailbox receives.** An attacker with rotating IPs — a botnet, a proxy pool, or plain IPv6 — multiplies your per-IP ceiling by the number of addresses they can reach, and every one of those requests lands in the same victim's inbox. That is why `emailRecipientLimiter` and `signupRecipientLimiter` key on the **recipient email address** instead. They are the controls that actually stop mail abuse; the IP-keyed `signupLimiter` is a speed bump.

There are **four** endpoints that mail an address the caller influences, and each has its own bucket. Two of them are not obvious from the route name, which is why the list is worth memorizing rather than re-deriving:

| Endpoint | Bucket | Keyed on |
| --- | --- | --- |
| `/send-verification-email`, `/request-password-reset` | `emailRecipientLimiter` | recipient address |
| `/sign-up/email` | `signupRecipientLimiter` | recipient address |
| `/sign-in/email` | `signinRecipientLimiter` | recipient address, **charged only when mail was sent** |
| `/two-factor/send-otp` | `twoFactorOtpLimiter` | the **challenge**, not the recipient |

`/sign-in/email` is a mailer only because `requireEmailVerification` and `sendOnSignIn` are both on — a config flag, not a plugin, turned an ordinary endpoint into one. `/two-factor/send-otp` is a mailer that Better-Auth caps *not at all*: it consumes the challenge cookie only on a successful verification, so one signed cookie can be replayed indefinitely, mailing its owner every time. When auditing this set, read `packages/auth/src/index.ts` for flags and callbacks that mail, not just the plugin array.

**2. A limiter keyed on attacker-supplied data can be turned into a weapon.** Because the mail limiters key on an address the caller supplies, a non-zero block duration would let an anonymous attacker deny a specific user their password reset for that long, extending it on every retry. Hence the recipient family's block duration is **code-fixed at 0** (deliberately not env-tunable): the window still caps throughput, but suppression can never outlast the window. Raising it is a code review that re-reads this paragraph, not a knob turn.

## Fail-open vs fail-closed

What happens when Redis is unreachable.

- **Fail-closed** (`credentialLimiter`, `credentialBurstLimiter`, `authLimiter`, `signupLimiter` — every limiter mounted `{ failClosed: true }` in `apps/server/src/index.ts` — plus the chat-send procedure budget (`rl:chat-send`), which is not mounted at all and refuses in its own `catch`) — the request is refused with a 503. These limiters deliberately carry **no in-memory backstop**, because credential-stuffing protection must not silently disappear during an outage, and a per-process ceiling is not a real defense across several replicas. You trade availability of `/api/auth/*` for that guarantee; the rest of the app stays up.
- **Fail-open** (everything else) — the request is allowed. A Redis blip should not take down your whole site.
  - Limiters built by `createSurfaceLimiter` (`rpcLimiter`, `imageLimiter`, `assetLimiter`, `readyLimiter`, `ssrLimiter`, `chatStreamLimiter`) — and `signinFailureLimiter`, which is hand-constructed but carries the same 1.5× backstop (see "The per-account layer" below) — additionally carry an in-memory `insuranceLimiter` at 1.5× the budget, so a per-process ceiling still applies during the outage.
  - `emailRecipientLimiter`, `signupRecipientLimiter`, `signinRecipientLimiter`, and `twoFactorOtpLimiter` fail open with **no backstop at all** — all four are hand-constructed and have no `insuranceLimiter`. During a Redis outage the per-recipient mail cap is simply gone; the IP-keyed `signupLimiter` in front of signup and the `credentialBurstLimiter` / `credentialLimiter` pair in front of sign-in and 2FA are fail-closed, but the password-reset/verification mail paths are not otherwise bounded per mailbox. That is a deliberate availability choice (a caller-supplied key must never be able to hard-block a user — least of all on the login page), not an oversight — but do not describe these four as "1.5× still applies".

If you are unsure which a new limiter needs: does losing it for ten minutes let an attacker do something irreversible (take an account, send mail as you, **spend your model budget**)? Fail closed. Otherwise fail open.

## Give every surface its own bucket

Each limiter has a distinct `keyPrefix`, and **that prefix is what makes its budget independent**. Mounting one limiter object on several unrelated routes silently merges them into a single bucket.

This template shipped exactly that bug. One `rpcLimiter` was mounted on `/rpc`, `/sw`, `/api/images` and — at the time — an HLS video route. It was not 100 requests per minute per surface; it was 100 per minute **total**. HLS streams one ~4-second segment at a time, so a 10-minute video is roughly 150 requests: watching one video exhausted the entire API budget for the minute and started 429ing the rest of the app mid-playback. The video route is gone (restore it via [add-ins/video.md](./add-ins/video.md), with its **own** limiter), but nothing about the lesson was specific to it — `/api/images/*` and `/api/assets/*` have the same shape at a smaller multiple, and any surface whose cost is "one request per fragment of one user action" will do it again the moment it shares a bucket.

Current budgets (code defaults) and the family each scales with:

| Surface | Limiter | Budget | Family | Sized for |
|---|---|---|---|---|
| `/rpc/*`, `/api-reference/*`, `/sw/*`, `/api/auth/get-session` | `rpcLimiter` | 100 | RPC (reference) | Ordinary API calls. One batched request can carry up to `ORPC_BATCH_MAX_SIZE` procedures, so the procedure ceiling is ~10×. |
| `/api/images/*` | `imageLimiter` | 300 | UPLOAD | A gallery or feed renders dozens of image variants per view. |
| Server-rendered pages (catch-all) | `ssrLimiter` | 300 | RPC | CPU protection against cache-busting query-string loops. |
| `/api/assets/*` | `assetLimiter` | 200 | UPLOAD (reference) | Same per-page multiplier as images — a list of attachments is many GETs — but fetched individually rather than as a dozen srcset variants of one picture. |
| `/ready` | `readyLimiter` | 60 | RPC | Touches Postgres and Redis per call. Its own bucket so a health-check loop and app traffic can never starve each other during an incident. |
| `/api/chat/*` (SSE stream) | `chatStreamLimiter` | 60 | CHAT | One long-lived connection per open chat tab, plus reconnects. Reconnect storms, not page fan-out. |
| `chat.send` / `chat.retry` (oRPC procedures) | `rl:chat-send` | 20 | CHAT (reference) | **Not a route.** One point = one accepted *turn*, which queues a run worth up to `CHAT_MAX_ITERATIONS` paid model dispatches. See "When the surface is a procedure, not a route" below. |
| `chat.createSession` (oRPC procedure) | `rl:chat-session` | 30 | CHAT | **Not a route**, and a separate bucket from the one above: a session costs a *row*, not a model call, so the spend budget never sees it — leaving row creation bounded by nothing for a client that never sends a message. |
| `/api/auth/sign-in/email` (failed attempts) | `signinFailureLimiter` | 10 / **900 s**, 10-min block | — (code constant) | **Not env-tuned — constants in `rate-limit.ts`.** Keyed on a SHA-256 of the email, charged only on 401s: see "The per-account layer" above. |
| `auth.verifyEmailTransport` (oRPC procedure) | `rl:auth-verify-email-transport` | 5 / **600 s** | — (code constant) | **Not a route.** Anonymous mid-2FA preflight where each point makes the server open a real SMTP connection and confirms email is configured — so it fails **closed** (mail is on the never-fail-open list; both login callers degrade a refusal to "code not sent" and TOTP keeps working). Keyed on the resolved client IP, sharing one `ip:unknown` fallback bucket. |

The `/api/assets/*` and `/ready` rows are the correction that proves the rule. An earlier pass split `/api/images/*` out of the shared bucket and left `/api/assets/*` in it, and mounted `/ready` on `rpcLimiter` in the same commit that documented not doing this. The two image/asset endpoints differ in whether they transform the bytes, not in how many requests a page makes — so half the bug survived the fix. When you split one surface out, re-read the whole mount list.

## What the bucket is keyed on

`resolveKey` picks the identity a budget is tracked against:

1. **Signed-in user** → `uid:<user id>`, so limits follow the account rather than the network. This requires `sessionMiddleware` to have run on that route.
2. **Anonymous** → the real client IP, resolved proxy-aware (`resolveClientIp`), never the spoofable leftmost `X-Forwarded-For` entry.

Every surface this template ships keys one of those two ways. If you add a
bearer-credential surface, two rules apply:

- **Key on the credential when a credential is what you are protecting.** IP is the fallback for anonymous traffic, not the goal. Hash it, so the credential stays out of Redis keys and out of any log line.
- **Any limiter that keys on caller-supplied data must sit behind one that does not.** A limiter runs before authentication — it has to, or an attacker spends your CPU on auth before being throttled — so its key is derived from something merely *presented*, not something *valid*. A bearer token, an email address, an API key are all attacker-chosen at that point, and any of them can be varied to mint a fresh bucket per request. Mount an IP-keyed limiter with its own `keyPrefix` in front (never a remount of `rpcLimiter` — that merges the two surfaces' budgets, the exact footgun this doc exists to prevent). The `emailRecipientLimiter` obeys the same rule: it is mounted *after* the IP-keyed `authLimiter` on the same routes, never instead of it.
- **A caller-supplied key cuts both ways: it also lets the caller fill *your* bucket.** Keying on a victim's email bounds mail to that mailbox, but every point the attacker spends is a point the victim cannot. Whether that matters depends entirely on what a 429 denies. On `/request-password-reset` it delays a reset. On `/sign-in/email` it would deny *logging in* — so the sign-in limiter charges a point only when the response says mail actually went out (`signinSentMail`, the `consumeWhen` parameter of `emailRecipientLimit`), never per attempt. A verified user's sign-in leaves no *lasting* charge — the point is refunded as the response goes out. Be precise about the residual, though: the point is reserved for the duration of the handler, and a password check is deliberately slow, so an attacker sustaining `points` concurrent attempts against one address keeps that bucket at its cap and a real sign-in arriving inside the window still gets a 429. It decays the instant the flood stops. The reservation is kept anyway because consuming *after* the handler cannot bound concurrent sends across replicas at all.

  Before adding a recipient-keyed limiter to a new surface, ask: *if an attacker who knows a user's address exhausts this bucket, what can that user no longer do?* If the answer is anything a legitimate user needs, meter the outcome, not the attempt.

### The per-account layer: failed sign-ins per email

`credentialLimiter` and `credentialBurstLimiter` key on client IP, which is exactly the control a rotating-IP stuffing campaign against ONE account defeats: every source address brings a fresh 10/60s budget, leaving only password length and 2FA to bound the guesses. `signinFailureLimiter` (enforced by `apps/server/src/signin-failure-limit.ts`) is the per-account half: **10 failed sign-ins per email within 15 minutes → further attempts for that email are rejected for 10 minutes.** It applies only to `POST /api/auth/sign-in/email` — never signup or password reset, which cannot fail a credential check and would gain nothing but the lever.

It is the "meter the outcome" rule applied to credentials. A point is charged only when the response is a **401** (`signinFailedCredentials`): a pre-password 403 (CSRF origin checks), a 400, or an inner 429 is refunded, and the charge is reserved before the handler and refunded on success, so a legitimate user's own sign-ins never accumulate. The residual lever is inherent to any per-account failure counter — an attacker who knows an address can still fill the bucket with wrong passwords — and the short matched windows are what bounds it: the worst outcome is a ten-minute blip on one account's login, retrying while blocked does not extend the block, and the campaign itself is capped at 10 password checks per 15 minutes per email no matter how many IPs it holds. Keys are a SHA-256 of the normalized email (`signinFailureKey`), never the raw address — the same reason a credential-keyed limiter hashes the credential. It fails **open** with the 1.5× in-memory insurance backstop, because the fail-closed IP-keyed pair mounted ahead of it on the same route remains the security floor. Its three numbers are constants in `rate-limit.ts`, not env vars: they are a matched anti-lever triple, and changing them is a code review, not a knob turn.

## When the surface is a procedure, not a route

Every limiter above is Hono middleware mounted on a path. `chat.send` and `chat.retry` are the one case where that does not work, and the reasons generalize to any procedure that costs more than a request:

- **A batch is one request.** The SPA's oRPC client batches, so several procedures arrive as a single POST to `/rpc/chat/__batch__` (up to `ORPC_BATCH_MAX_SIZE` of them). Path-mounted middleware charges that one point no matter how many sends it carried.
- **The path does not name the procedure.** `/rpc/chat/*` covers `listMessages` as much as `send`; a budget sized for one is wrong for the other.

So the chat-send budget lives beside the procedures it guards, in `packages/api/src/lib/chat-rate-limit.ts`, built with `createProcedureBudget` (`packages/api/src/lib/procedure-budget.ts`); `chat.send` / `chat.retry` call `consumeChatSendBudget(userId)` before taking their claim. `apps/server/src/rate-limit.ts` carries a pointer comment so the mount list stays honest. It is otherwise an ordinary member of the strict family: own `keyPrefix` (`rl:chat-send`), the CHAT budget's reference member, no `insuranceLimiter`.

`chat.createSession` sits in the same file and takes the same shape, on its **own** `keyPrefix` (`rl:chat-session`) — and that separation is the point rather than boilerplate. The two surfaces are bounded by different costs: one meters money, the other meters rows. Folding them into one bucket goes wrong in both directions — it would price opening a conversation as though it called a model (throttling a user skimming several), and, in the direction that actually matters, leave row creation metered by a budget a client that never sends a message never touches. This is the general rule from the top of this doc in miniature: `keyPrefix` is what makes a budget independent, so *one bucket per surface* means per **cost**, not per file.

**What one point buys, and why it is not a request.** An accepted send commits a user message, flips the session to `RUNNING`, and enqueues a `chat-run` job that may spend up to `CHAT_MAX_ITERATIONS` **paid model dispatches**. `CHAT_RUN_CONCURRENCY` only decides how fast that queue drains — the excess is *queued*, never shed — so the 100/min `/rpc/*` ceiling let one signed-in client build an indefinitely growing, indefinitely expensive backlog while looking like ordinary API traffic. Size this budget by counting turns, not HTTP calls: a conversational turn is one point, `send` is refused outright while its session is `RUNNING` (so a single conversation cannot even reach 2/minute), and 20/60 s clears a fast human with several sessions open in several tabs plus their retries.

**Keyed on the user, and the caller-supplied-key rule does not fire here.** The key is `uid:<id>` read from the session `protectedProcedure` already validated — not a bearer that was merely *presented*. A credential-keyed limiter needs an IP-keyed limiter in front of it because it runs before authentication, so varying the token mints a bucket per request; this one runs after, so minting a bucket means minting an *account* (signup + verification, bounded by `signupLimiter` and `signupRecipientLimiter`). The coarser layer is there regardless and was not tightened: every `/rpc/*` request still passes the IP-or-user-keyed `rpcLimiter` first. Note also that the "a caller-supplied key lets the caller fill *your* bucket" hazard is absent — the only account that can exhaust this budget is the one making the requests — which is why it charges the *attempt* rather than metering the outcome as the mail limiters do.

**Fail-closed, with almost no availability cost.** Apply the test: losing it for ten minutes lets a caller do something irreversible — spend, plus occupy worker slots denied to everyone else until the backlog drains. And refusing costs little that was not already lost, because the very next thing an accepted send does is `enqueueChatRun` against the same Redis: with Redis down the turn fails anyway, just *after* a claim and a user message have been committed instead of before. No `blockDuration`: the window already caps spend, and a block would only deny a user their own conversation for minutes after a burst.

**Two rules for the next one of these.** When a budget guards a multi-step pipeline, charge the procedure that *gates* it rather than the one that enqueues: if a later step cannot be reached without passing the gated one, a single point covers the whole chain and the later steps need no bucket of their own. And size the window to the unit of work instead of defaulting to 60 s — `rl:auth-verify-email-transport` runs 5 per **600 s** because one point opens a real SMTP connection on an anonymous path, and a window shorter than the work it meters is not a budget.

**Fail-closed is not automatic — apply the test, do not copy the answer.** Every procedure budget this template ships fails closed, but each argues the case on its own terms — spend (`rl:chat-send`), a real SMTP connection (`rl:auth-verify-email-transport`), a row whose session is unusable without Redis anyway (`rl:chat-session`). A budget over a cheap, small write whose *absence* is the real cost comes out the other way: for an audit or accountability row kept precisely so you can prove it exists, failing closed during a Redis blip drops the record you are legally on the hook for, in exchange for bounding a burst of tiny rows a retention sweep clears anyway — log it and let the write through. Ask the ten-minute question about the procedure in front of you; do not inherit the answer from the budget next to it.

**A procedure budget's key is a warning about fallbacks.** `resolveClientIp` (`apps/server/src/client-ip.ts`) never returns `undefined` — when it cannot identify a caller it returns the literal string `"unknown"`, which is truthy, so a plain `clientIp ? ip-key : fallback-key` ternary quietly funnels every unidentifiable visitor into one shared `ip:unknown` bucket and makes the fallback branch dead code. Compare against the sentinel, not against truthiness — `verifyEmailTransportBudgetKey` in `packages/api/src/routers/auth.ts` does, and documents why sharing one `ip:unknown` bucket is the safe direction for that surface rather than an accident.

## One limiter layer, not two

Better-Auth ships its own rate limiter. This template turns it **off** (`rateLimit: { enabled: false }` in `packages/auth/src/index.ts`) and relies on the limiters above, which cover the same routes.

This is a consolidation, not a removal, and the reason matters because the defaults are a trap:

- Its default storage is **memory**, so the effective limit multiplies by replica count and resets on every deploy.
- Its IP resolution returns null when `X-Forwarded-For` carries more than one entry and no `trustedProxies` is configured — the normal case behind Traefik, a CDN, or any two-hop proxy chain. The key then degenerates to the literal string `"no-trusted-ip"`, **shared by every client**. Its built-in rule of 3 sign-ins per 10 seconds would then apply to the entire deployment at once: simultaneously a self-inflicted outage and no defense at all, announced by a single startup warning.
- It is enabled in production only, so none of this is visible in development.

Running both layers would also double-count and make a 429 impossible to attribute. If you ever re-enable it, configure `advanced.ipAddress.trustedProxies` **and** a `secondaryStorage` first.

**Replace what you disable.** Turning that limiter off also drops its 3-sign-ins-per-10-seconds rule, and a 60-second bucket does not reproduce it: 10 requests per 60 s happily permits ten guesses inside one second, which is the shape credential stuffing actually has. `credentialBurstLimiter` (3 / 10 s, mounted on the same routes as `credentialLimiter`) restores that ceiling on a correctly-keyed, Redis-backed, replica-wide counter. Two windows on one surface is the right pattern whenever burst and sustained rates need different answers — it is not the shared-bucket mistake, because each window has its own `keyPrefix`.

### The related footgun: polling endpoints

The auth surface is sized for humans clicking things. A polling client is not. A grant that polls every 5 seconds sends **12 requests per minute** for as long as the flow takes; under the general 30/60 s `authLimiter`, two concurrent flows behind one office egress trip a fail-closed five-minute block — which takes sign-in and password reset down with them, for everyone on that IP.

The fix is a dedicated bucket for the polling paths, sized off the poll interval rather than off human behaviour, with the general `authLimiter` explicitly skipping them.

The general lesson: **before mounting an existing limiter on a new route, ask whether the client polls.** A polling client is not a heavier user, it is a different traffic shape, and it will quietly consume a budget sized for a different one.

### The related footgun: a plugin's own quota

A Better-Auth plugin that issues a standing credential may ship its own per-credential quota, and the defaults are sized for a different product than yours (the api-key plugin's was **10 requests per 24 hours**). Such a quota is typically stamped onto each row at creation time, so raising the maximum only affects newly issued credentials while the already-issued ones stay broken. Disable the plugin's limiter and mount a Redis-backed one of your own instead, per the credential-keying rules above.

## Adding a limiter for a new surface

1. **Count the cost of one user action.** How many requests does a single legitimate interaction make? Multiply by a comfortable factor. A page that fires 8 queries on mount costs 8, not 1. A media player costs one request per segment.
2. **Pick the family.** Credentials or outbound mail → strict and fail-closed. Everything else → `createSurfaceLimiter(name, member)`, which is fail-open with a 1.5× in-memory backstop. The member is a code constant resolved from that family's budget.
3. **Give it its own name**, which becomes its `keyPrefix` and its independent bucket.
4. **Wire the budget.** Add the member to its family in `packages/api/src/lib/rate-limit-families.ts` consumers (`rate-limit.ts` / `chat-rate-limit.ts`) as a code constant with a comment on what one point buys — it then scales with that family's `RATE_LIMIT_<FAMILY>_*` budget. Do NOT add a new per-surface env var: per-surface knobs were collapsed to the five named budgets on purpose, and `pnpm env:check` budgets the `.env.example` key count. A genuinely new *cost class* (not a new member of an existing family) is the only case that justifies another budget — schema (`packages/env/src/vars/server.ts`) + manifest + `.env.example` budget, all in one commit. See [environment-variables](./environment-variables.md).
5. **Mount it before the handler** in `apps/server/src/index.ts`, and before any gate you want brute-force protection on. If the surface is an oRPC *procedure* rather than a route, mounting is not an option — enforce it in the procedure, before it commits anything.
6. **Update the tables in this file.**

```ts
// apps/server/src/rate-limit.ts
const reportBudget = rpcRateFamily({ points: 50, windowSeconds: 60 }); // RPC-family member
export const reportLimiter = createSurfaceLimiter("report", reportBudget);

// apps/server/src/index.ts
app.use("/api/reports/*", createRateLimiterMiddleware(reportLimiter));
```

## Tuning in production

Every family is retunable through its budget env pair, so you can retune without a code change — but a deploy is still needed for the process to pick it up.

Symptoms and the knob to turn:

| Symptom | Likely cause | Knob |
|---|---|---|
| Legitimate users at one company get "Too many attempts" on sign-in | Shared NAT | `RATE_LIMIT_AUTH_POINTS` up (the whole auth family scales), or `RATE_LIMIT_AUTH_WINDOW_SECONDS` down |
| A gallery or attachment list 429s partway through loading | Upload budget too small for the per-page request count | `RATE_LIMIT_UPLOAD_POINTS` (images and assets scale together) |
| A dashboard 429s on load | Many concurrent queries in one tick | `RATE_LIMIT_RPC_POINTS`, and check batching in [data-fetching](./data-fetching.md) |
| "You're sending messages faster than they can be answered" | Chat spend budget for that user | `RATE_LIMIT_CHAT_POINTS` — but first check whether the client is re-sending on its own |
| "You're starting conversations faster than expected" | Chat session-creation budget for that user | `RATE_LIMIT_CHAT_POINTS` — a human hitting this is unusual; check for a client creating a session per render first |
| Chat sends 503 while the rest of the app works | Redis is down and this limiter fails closed — by design | Fix Redis (the enqueue behind it needs Redis anyway) |
| Everything 503s on `/api/auth/*` | Redis is down and these fail closed — by design | Fix Redis |

Do **not** respond to a 429 by disabling a limiter. Raise the specific budget that is wrong, and say in the commit message which user action justified the new number.

A 413 on `/rpc/.../__batch__` is **not** a rate limit — see [data-fetching § Debugging a 413](./data-fetching.md#debugging-a-413-on-rpcbatch).

## Cross-references

- [production-hardening.md](./production-hardening.md) — the pre-launch checklist that includes these limits.
- [environment-variables.md](./environment-variables.md) — the env schema/manifest contract behind the five budget pairs.
- [data-fetching.md](./data-fetching.md) — batching, and the 413 that is not a rate limit.
