# thook — The AI Email-to-Webhook Parser

Route fragile, automated emails (supplier invoices, real-estate leads, CSV
alerts) to thook. thook extracts structured data with an LLM against a
developer-defined schema and fires a signed webhook at your application.

This repository currently implements **Step 1: the core inbound loop** —
the database schema, the `/api/v1/inbound-email` route handler, and
**Step 2: reliable delivery** (automatic retry with exponential backoff
+ manual replay). No landing page, billing, or dashboard yet.

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
