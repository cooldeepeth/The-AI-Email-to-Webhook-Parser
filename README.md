# thook — The AI Email-to-Webhook Parser

Route fragile, automated emails (supplier invoices, real-estate leads, CSV
alerts) to thook. thook extracts structured data with an LLM against a
developer-defined schema and fires a signed webhook at your application.

Implemented so far: **Step 1** the core inbound loop (schema +
`/api/v1/inbound-email`), **Step 2** reliable delivery (automatic retry
with exponential backoff + manual replay), **Step 3** the authenticated
management API (endpoint CRUD, secret rotation, log inspection), and
**Step 4** the dashboard UI. No landing page or billing yet.

## Architecture

```
Postmark inbound webhook
        │  POST /api/v1/inbound-email   (auth: Basic / token)
        ▼
1. Receive & validate Postmark payload
2. Match active endpoint by recipient slug (slug@inbound.thook.io)
3. Insert webhook_logs row (status = processing)
4. AI parse: ai_prompt_schema + email body  ->  strict JSON
5. Dispatch: HMAC-SHA256 sign  ->  POST target_webhook_url
6. Update webhook_logs (success | failed_ai | failed_delivery)

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
| `src/app/api/v1/inbound-email/route.ts` | The inbound loop handler |
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

Watch the parsed JSON arrive at webhook.site, then inspect
`webhook_logs` in Supabase for the final `status`,
`parsed_json_output`, and `http_response_code`.

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

Every failure point updates `webhook_logs` and still returns `200` to
Postmark (so it does not retry an inherently undeliverable email):

| Stage | Status written |
| --- | --- |
| LLM error / unparseable output | `failed_ai` |
| Outbound POST error / timeout / non-2xx | `failed_delivery` |
| Delivered (2xx from your server) | `success` |

`401` is returned only for a bad inbound token; `400` only for a
malformed JSON body.

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
