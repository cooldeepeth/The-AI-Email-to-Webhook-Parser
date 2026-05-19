# thook — The AI Email-to-Webhook Parser

Route fragile, automated emails (supplier invoices, real-estate leads, CSV
alerts) to thook. thook extracts structured data with an LLM against a
developer-defined schema and fires a signed webhook at your application.

Implemented so far: **Step 1** the core inbound loop (schema +
`/api/v1/inbound-email`), **Step 2** reliable delivery (automatic retry
with exponential backoff + manual replay), **Step 3** the authenticated
management API (endpoint CRUD, secret rotation, log inspection),
**Step 4** the dashboard UI, **Step 5** usage metering + monthly
plan quotas, **Step 6** Stripe billing (Checkout / portal / webhook
plan-flip) behind a deliberately tiny pricing page, and **Step 7** the
async processing queue (the inbound route no longer does LLM work
inline). No landing page yet.

## Architecture

The inbound route is intentionally I/O-only — it persists the email and
returns instantly, so a slow LLM call or slow destination can never
trip the serverless timeout. All parsing/dispatch is drained by a cron
worker off a claim-based Postgres queue.

```
Postmark inbound webhook
        │  POST /api/v1/inbound-email   (auth: Basic / token)
        ▼
1. Receive & validate Postmark payload
2. Match active endpoint by recipient slug (slug@inbound.thook.io)
3. Enforce monthly quota (record_usage_and_check)
4. Insert webhook_logs row (status = pending) + return 200 immediately

Vercel Cron (* * * * *)
        │  POST /api/v1/cron/process-pending  (auth: Bearer CRON_SECRET)
        ▼
   claim_pending_logs() atomically flips a small batch to 'processing'
   (FOR UPDATE SKIP LOCKED — overlap-safe; also reclaims rows stuck in
   'processing' > PROCESSING_STALE_MINUTES, i.e. a crashed worker):
     • AI parse  -> on success: dispatch (HMAC-SHA256 signed POST)
                    -> success | failed_delivery
     • transient AI failure (timeout / 429 / 5xx / network / flaky
       JSON)  -> re-queued to 'pending' with backoff via next_retry_at,
       capped by MAX_DELIVERY_RETRIES, then 'failed_ai'
     • hard AI failure (4xx / auth)  -> 'failed_ai' (terminal)

Vercel Cron (*/5 * * * *)
        │  POST /api/v1/cron/retry-deliveries  (auth: Bearer CRON_SECRET)
        ▼
   Re-deliver every 'failed_delivery' log whose backoff window has
   elapsed (retry_count < MAX_DELIVERY_RETRIES); flip to 'success' or
   bump retry_count. Manual one-off replay: POST /api/v1/logs/{id}/replay
```

## Project layout

| Path | Purpose |
| --- | --- |
| `supabase/migrations/0001_initial_schema.sql` | Full Postgres DDL + RLS |
| `supabase/migrations/0002_usage_and_plans.sql` | Plans, usage counters, quota fn |
| `supabase/migrations/0003_billing_stripe.sql` | Stripe linkage + `set_account_plan` |
| `supabase/migrations/0004_async_processing_queue.sql` | `pending` status + `claim_pending_logs` |
| `src/lib/plans.ts` | The 3-plan matrix (quotas, Pro price) |
| `src/lib/stripe.ts` | Lazy Stripe client |
| `src/app/pricing/page.tsx` | Pricing page (3 cards) |
| `src/app/api/v1/billing/checkout/route.ts` | Start Pro Checkout |
| `src/app/api/v1/billing/portal/route.ts` | Stripe billing portal |
| `src/app/api/v1/billing/webhook/route.ts` | Stripe webhook → plan flip |
| `src/app/api/v1/usage/route.ts` | Plan + month-to-date usage |
| `src/app/api/v1/inbound-email/route.ts` | Inbound: persist `pending`, return 200 |
| `src/app/api/v1/cron/process-pending/route.ts` | Async AI-parse + dispatch worker |
| `src/app/api/v1/cron/retry-deliveries/route.ts` | Backoff retry worker |
| `src/app/api/v1/logs/[id]/replay/route.ts` | Manual single-log replay |
| `src/app/api/v1/endpoints/route.ts` | List / create endpoints |
| `src/app/api/v1/endpoints/[id]/route.ts` | Get / update / delete endpoint |
| `src/app/api/v1/endpoints/[id]/rotate-secret/route.ts` | Rotate webhook secret |
| `src/app/api/v1/endpoints/[id]/logs/route.ts` | Paginated endpoint logs |
| `src/app/api/v1/logs/[id]/route.ts` | Single full log |
| `src/app/login/page.tsx` | Email/password auth (Supabase browser) |
| `src/app/page.tsx` | Dashboard: list + create endpoints |
| `src/app/endpoints/[id]/page.tsx` | Edit/delete, rotate secret, logs |
| `src/app/logs/[id]/page.tsx` | Full log (raw + parsed) view |
| `src/components/AuthGate.tsx` | Client session guard |
| `src/lib/api-client.ts` | Browser fetch wrapper (injects JWT) |
| `src/lib/supabase-browser.ts` | Browser Supabase client |
| `src/lib/auth.ts` | Supabase-JWT auth → RLS-scoped client |
| `src/lib/validation.ts` | Slug/secret generation + input checks |
| `src/lib/dispatch.ts` | Shared sign + deliver (inbound & retry) |
| `src/lib/retry.ts` | Exponential-backoff eligibility |
| `src/lib/ai.ts` | Anthropic / OpenAI provider + robust JSON extraction |
| `src/lib/signature.ts` | HMAC-SHA256 payload signing |
| `src/lib/supabase.ts` | Service-role client |
| `src/lib/env.ts` | Lazily validated env access |
| `vercel.json` | Cron schedule for the retry worker |

## 1. Database setup

Apply the migration to your Supabase project — either with the Supabase
CLI (`supabase db push`) or by pasting
`supabase/migrations/0001_initial_schema.sql` into the SQL editor.

Create a test endpoint:

```sql
insert into public.endpoints
  (user_id, name, inbound_email_slug, target_webhook_url, ai_prompt_schema)
values
  ('<an auth.users uuid>',
   'Supplier Invoice Parser',
   'xyz123',
   'https://webhook.site/<your-uuid>',
   'Extract these keys: total_amount (number), invoice_date (YYYY-MM-DD), vendor_name (string).')
returning inbound_email_slug, webhook_secret;
```

`webhook_secret` is auto-generated — save it to verify signatures on your
receiving server.

## 2. Environment variables

```bash
cp .env.example .env.local
```

Fill in `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
`POSTMARK_INBOUND_WEBHOOK_TOKEN`, and your AI provider key. See
`.env.example` for the full annotated list.

## 3. Run locally

```bash
npm install
npm run dev          # http://localhost:3000
npm run typecheck    # optional: strict TS check
```

## 4. Test the loop without real email

You don't need Postmark to exercise the pipeline.

**a. A destination to receive the outbound webhook.** Open
<https://webhook.site>, copy your unique URL, and use it as the
endpoint's `target_webhook_url` (see the SQL above).

**b. Simulate Postmark's inbound POST** with curl. The body mirrors
Postmark's inbound schema; auth uses the Basic password or `?token=`:

```bash
curl -u "postmark:$POSTMARK_INBOUND_WEBHOOK_TOKEN" \
  -X POST http://localhost:3000/api/v1/inbound-email \
  -H "content-type: application/json" \
  -d '{
    "FromFull": { "Email": "billing@acme-supplies.com" },
    "ToFull": [{ "Email": "xyz123@inbound.thook.io" }],
    "Subject": "Invoice #4471",
    "TextBody": "Hi, please find invoice #4471 dated 2026-05-12. Amount due: $1,284.50 from ACME Supplies Inc.",
    "MessageID": "test-0001",
    "Date": "Mon, 12 May 2026 10:00:00 -0000"
  }'
```

The response is immediate: `{ "ok": true, "status": "pending",
"log_id": "…" }`. Nothing is parsed yet. Drain the queue by invoking
the worker (in production Vercel Cron does this every minute):

```bash
curl -X POST "http://localhost:3000/api/v1/cron/process-pending" \
  -H "authorization: Bearer $CRON_SECRET"
```

Watch the parsed JSON arrive at webhook.site, then inspect
`webhook_logs` in Supabase for the final `status`,
`parsed_json_output`, and `http_response_code`. A transient AI error
leaves the row `pending` with a future `next_retry_at`; just run the
worker again after it elapses.

## 5. Wire up real Postmark inbound

1. Expose your local server:
   ```bash
   ngrok http 3000
   ```
2. In Postmark → your inbound stream → set the **Inbound Webhook URL** to:
   ```
   https://postmark:<POSTMARK_INBOUND_WEBHOOK_TOKEN>@<your-ngrok-subdomain>.ngrok-free.app/api/v1/inbound-email
   ```
   (or append `?token=<POSTMARK_INBOUND_WEBHOOK_TOKEN>`).
3. Point Postmark's inbound domain (`inbound.thook.io`) MX records at
   Postmark, then send mail to `xyz123@inbound.thook.io`.

## Verifying the outbound signature (developer side)

thook signs `${X-Thook-Timestamp}.${rawBody}` with HMAC-SHA256 using your
`webhook_secret`:

```ts
import { createHmac, timingSafeEqual } from "node:crypto";

function verify(rawBody: string, headers: Record<string, string>, secret: string) {
  const expected = createHmac("sha256", secret)
    .update(`${headers["x-thook-timestamp"]}.${rawBody}`)
    .digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(headers["x-thook-signature"]);
  return a.length === b.length && timingSafeEqual(a, b);
}
```

## Failure handling

The inbound route returns `200` with `status: pending` once the email
is durably stored (or `200` with an `error` for an unroutable
recipient / over-quota account, so Postmark does not retry something
inherently undeliverable). `401` is only a bad inbound token; `400`
only a malformed JSON body; `5xx` only if the row could not be stored
(Postmark *should* redeliver then). All parse/delivery outcomes are
written later by the async worker:

| Stage | Status written |
| --- | --- |
| Awaiting the worker | `pending` |
| Claimed by the worker (in flight) | `processing` |
| Transient LLM error (timeout / 429 / 5xx / flaky JSON), retries left | `pending` (backoff) |
| LLM error, retries exhausted or hard 4xx/auth | `failed_ai` |
| Outbound POST error / timeout / non-2xx | `failed_delivery` |
| Delivered (2xx from your server) | `success` |

## Delivery retries (Step 2)

A `failed_delivery` log is not terminal. The cron worker re-attempts it
with exponential backoff until it succeeds or hits the retry ceiling.

- **Eligibility:** `status = 'failed_delivery'` AND
  `retry_count < MAX_DELIVERY_RETRIES` AND at least
  `RETRY_BACKOFF_MINUTES[retry_count]` elapsed since the last attempt
  (`updated_at`, maintained by trigger).
- **Outcome:** 2xx → `success`; otherwise `retry_count++` and the error
  is recorded. An endpoint that was deleted/disabled (or a log with no
  parsed output) is parked at the retry ceiling instead of looping.
- **Schedule:** `vercel.json` runs the worker every 5 minutes. Vercel
  injects `Authorization: Bearer $CRON_SECRET` automatically when the
  `CRON_SECRET` env var is set on the project.

Trigger it manually (e.g. locally) the same way Vercel does:

```bash
curl -X POST "http://localhost:3000/api/v1/cron/retry-deliveries" \
  -H "authorization: Bearer $CRON_SECRET"
```

Replay one specific log on demand (operator action — does not change
`retry_count`):

```bash
curl -X POST "http://localhost:3000/api/v1/logs/<log-uuid>/replay" \
  -H "authorization: Bearer $CRON_SECRET"
```

> The retry worker re-signs each attempt with a fresh
> `X-Thook-Timestamp`, so receivers using the timestamped verification
> snippet above continue to validate correctly. The outbound JSON body
> is rebuilt deterministically from the stored log, so retried payloads
> are identical to the original.

## Management API (Step 3)

All routes require a Supabase **user** JWT
(`Authorization: Bearer <access_token>`). The token is used to build the
Supabase client, so every query runs under the owner-scoped RLS policies
from the migration — authorization is enforced by Postgres, not
re-implemented in the API. Get a token from your Supabase auth flow
(e.g. `supabase.auth.signInWithPassword`).

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/v1/endpoints` | List your endpoints (no secrets) |
| `POST` | `/api/v1/endpoints` | Create (slug auto-generated if omitted) |
| `GET` | `/api/v1/endpoints/{id}` | Get one (includes `webhook_secret`) |
| `PATCH` | `/api/v1/endpoints/{id}` | Partial update of mutable fields |
| `DELETE` | `/api/v1/endpoints/{id}` | Delete (cascades its logs) |
| `POST` | `/api/v1/endpoints/{id}/rotate-secret` | New `webhook_secret` (shown once) |
| `GET` | `/api/v1/endpoints/{id}/logs` | Logs, `?status=&limit=&offset=` |
| `GET` | `/api/v1/logs/{id}` | One log incl. raw + parsed payloads |

```bash
TOKEN="<supabase-user-access-token>"

# create an endpoint
curl -X POST http://localhost:3000/api/v1/endpoints \
  -H "authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{"name":"Supplier Invoice Parser",
       "target_webhook_url":"https://webhook.site/<uuid>",
       "ai_prompt_schema":"Extract total_amount, invoice_date, vendor_name."}'

# list its recent failed deliveries
curl "http://localhost:3000/api/v1/endpoints/<id>/logs?status=failed_delivery&limit=20" \
  -H "authorization: Bearer $TOKEN"
```

Validation errors return `400`, slug collisions `409`, missing/owned-by-
someone-else resources `404`, and bad/expired tokens `401`.

## Dashboard UI (Step 4)

A client-rendered Next.js dashboard over the Step 3 API. Auth is handled
in the browser by Supabase (`@supabase/supabase-js`); the session JWT is
forwarded to every API call, so RLS still enforces ownership.

Set the browser-exposed env vars (in addition to the server ones):

```
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
```

Then `npm run dev` and open <http://localhost:3000>:

- `/login` — email/password sign in & sign up.
- `/` — list endpoints, create a new one.
- `/endpoints/{id}` — edit config, toggle active, rotate the webhook
  secret, view the inbound address, browse logs (filter by status).
- `/logs/{id}` — status, retries, error, parsed JSON, raw payload.

> Manual replay stays an operator action guarded by `CRON_SECRET` and is
> intentionally not exposed in the user dashboard; the cron worker
> already auto-retries failed deliveries.

## Usage metering & quotas (Step 5)

Every accepted email is metered per account, per calendar month, and
checked against the account's plan quota **before** any paid LLM call.

- **Plans:** `plan_tier` enum (`free` / `pro` / `scale`). A `free`
  account (100/month default) is provisioned lazily on the first email
  via `record_usage_and_check()` — a `SECURITY DEFINER` function that
  atomically rolls the billing period, rejects without incrementing when
  the quota is hit, otherwise counts and returns the new total.
- **Enforcement:** in the inbound route this runs right after endpoint
  match. Over quota → a `quota_exceeded` log row is written and `200`
  is returned to Postmark (retrying would not help), with **no** LLM
  spend. Rejected mail is recorded but never counted.
- **Visibility:** `GET /api/v1/usage` (user JWT) returns
  `{ plan, monthly_quota, used, remaining, period_start }`; the
  dashboard shows a usage bar and the log filter includes
  `quota_exceeded`.
- **Changing a plan/quota today:** update the account's row, e.g.
  `update billing_accounts set plan='pro', monthly_quota=10000 where user_id='…';`
  Stripe-driven plan changes are the next step.

> Quotas live in the DB (per-account), not env, so they can change
> without a deploy. The check is intentionally before AI work so an
> abusive or runaway sender cannot run up an API bill.

## Billing (Step 6)

The whole offer is **three choices** — self-host (free, this repo),
Hosted Free (100/mo), Hosted Pro ($29/mo, 3,000/mo). Anything else
(BYO-key quota bumps, enterprise, lifetime self-host licence) stays off
the pricing page on purpose.

- **Single source of truth:** `src/lib/plans.ts` (quotas + Pro price).
  Only `free` and `pro` are surfaced; the `scale` enum value is reserved
  for a future negotiated tier.
- **Checkout:** `POST /api/v1/billing/checkout` (user JWT) creates/reuses
  the account's Stripe customer and returns a Checkout Session `url`.
- **Self-serve management/cancel:** `POST /api/v1/billing/portal` returns
  a Stripe billing-portal `url`.
- **Plan flip:** `POST /api/v1/billing/webhook` verifies the Stripe
  signature and calls the idempotent `set_account_plan()` DB function on
  `checkout.session.completed` (→ Pro), `customer.subscription.updated`
  (active/trialing/past_due → Pro, else Free), and
  `customer.subscription.deleted` (→ Free). Failures return non-2xx so
  Stripe retries.

Set `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, and
`STRIPE_PRO_PRICE_ID` (see `.env.example`). Create one recurring $29
Price for the Pro product and point a webhook at
`/api/v1/billing/webhook` for the three subscription events above; use
`stripe listen --forward-to localhost:3000/api/v1/billing/webhook`
locally.

> **Deliberately deferred (next slice, not half-built):** per-parse
> metered overage ($0.01) reporting to Stripe — it removes the hard cap
> and is a behavioural change — and the `/self-host` commercial-licence
> page. The current Pro plan is a clean higher quota, same hard-cap
> semantics as Free.

## Async processing queue (Step 7)

The inbound handler used to parse with the LLM and POST the destination
webhook synchronously — a slow model call or slow destination could
exceed the Vercel serverless timeout and drop the email. It is now
split:

- **`/api/v1/inbound-email`** authenticates, validates, resolves the
  endpoint, enforces the quota, writes one `webhook_logs` row with
  `status = pending`, and returns `200` immediately. No outbound calls.
- **`/api/v1/cron/process-pending`** (Vercel Cron, every minute) calls
  `claim_pending_logs(limit, stale_minutes)` — an atomic
  `UPDATE … FOR UPDATE SKIP LOCKED` that flips a small batch to
  `processing`. SKIP LOCKED makes overlapping cron runs safe; the same
  function also reclaims rows stuck in `processing` past
  `PROCESSING_STALE_MINUTES`, so a worker that dies mid-batch
  self-heals with no external queue/infra.
- For each claimed row it parses with the LLM, then dispatches. A
  **transient** AI failure (timeout, `429`, `5xx`, network, or a flaky
  non-JSON response) is re-queued to `pending` with exponential
  backoff via `next_retry_at`, capped at `MAX_DELIVERY_RETRIES`, then
  `failed_ai`. A **hard** failure (other `4xx` / auth / missing
  endpoint) goes straight to terminal `failed_ai`.
- A successful parse that fails to deliver becomes `failed_delivery`
  with `retry_count` reset, handed to the existing **retry-deliveries**
  worker (AI-stage retries are not charged against delivery attempts).
- The worker stops claiming new items ~5s before `maxDuration`; any
  not-yet-processed claimed rows are picked up by the next run's stale
  reaper. Tunables: `AI_PROCESS_BATCH_SIZE`, `PROCESSING_STALE_MINUTES`
  (see `.env.example`).

> Quota is still counted once, at acceptance, in the inbound route — AI
> retries never double-count. Apply migration
> `0004_async_processing_queue.sql` before deploying this step.
