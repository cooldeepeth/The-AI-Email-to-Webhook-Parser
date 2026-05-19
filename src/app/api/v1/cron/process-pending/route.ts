import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";
import { getServiceClient } from "@/lib/supabase";
import { parseEmailWithAi, isTransientAiError } from "@/lib/ai";
import { buildOutboundBody, deliver } from "@/lib/dispatch";
import { backoffDelayMs } from "@/lib/retry";
import type { WebhookLogStatus } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Stop claiming new work this far before the function is killed so the
// in-flight item can finish and its result can be written.
const RUN_DEADLINE_MS = 55_000;

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`. */
function isAuthorized(req: NextRequest): boolean {
  let secret: string;
  try {
    secret = env.cronSecret;
  } catch {
    return false;
  }
  const auth = req.headers.get("authorization") ?? "";
  if (auth.startsWith("Bearer ") && safeEqual(auth.slice(7), secret)) {
    return true;
  }
  const q = req.nextUrl.searchParams.get("secret");
  return !!q && safeEqual(q, secret);
}

interface JoinedLog {
  id: string;
  retry_count: number;
  raw_email_payload: Record<string, unknown> | null;
  endpoint:
    | {
        id: string;
        target_webhook_url: string;
        webhook_secret: string;
        ai_prompt_schema: string;
        is_active: boolean;
      }
    | null;
}

async function handle(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json(
      { ok: false, error: "unauthorized" },
      { status: 401 },
    );
  }

  const supabase = getServiceClient();
  const startedAt = Date.now();

  // Atomically claim a batch (and reclaim crashed-worker leftovers).
  const { data: claimed, error: claimError } = await supabase.rpc(
    "claim_pending_logs",
    {
      p_limit: env.aiProcessBatchSize,
      p_stale_minutes: env.processingStaleMinutes,
    },
  );

  if (claimError) {
    return NextResponse.json(
      { ok: false, error: "claim_failed", detail: claimError.message },
      { status: 500 },
    );
  }

  const ids = (claimed as string[] | null) ?? [];
  if (ids.length === 0) {
    return NextResponse.json({ ok: true, claimed: 0, processed: 0 });
  }

  const { data: logs, error: fetchError } = await supabase
    .from("webhook_logs")
    .select(
      "id,retry_count,raw_email_payload," +
        "endpoint:endpoints(id,target_webhook_url,webhook_secret," +
        "ai_prompt_schema,is_active)",
    )
    .in("id", ids)
    .returns<JoinedLog[]>();

  if (fetchError) {
    // Rows stay 'processing'; the stale reaper re-claims them next run.
    return NextResponse.json(
      { ok: false, error: "fetch_failed", detail: fetchError.message },
      { status: 500 },
    );
  }

  let delivered = 0;
  let aiRequeued = 0;
  let aiFailed = 0;
  let deliveryFailed = 0;
  let deferred = 0;

  for (const log of logs ?? []) {
    // Out of time: leave the rest 'processing' for the next run's reaper.
    if (Date.now() - startedAt > RUN_DEADLINE_MS) {
      deferred++;
      continue;
    }

    const endpoint = log.endpoint;
    if (!endpoint || !endpoint.is_active) {
      await supabase
        .from("webhook_logs")
        .update({
          status: "failed_ai" as WebhookLogStatus,
          next_retry_at: null,
          error_message: "endpoint inactive or deleted",
        })
        .eq("id", log.id);
      aiFailed++;
      continue;
    }

    const raw = log.raw_email_payload ?? {};
    const fromFull = raw.FromFull as { Email?: string } | undefined;
    const body =
      (raw.TextBody as string | undefined)?.trim() ||
      (raw.StrippedTextReply as string | undefined)?.trim() ||
      (raw.HtmlBody as string | undefined)?.trim() ||
      "";

    let parsedJson: Record<string, unknown>;
    try {
      const result = await parseEmailWithAi({
        schemaInstructions: endpoint.ai_prompt_schema,
        subject: (raw.Subject as string) ?? "",
        from: fromFull?.Email ?? (raw.From as string) ?? "",
        body,
      });
      parsedJson = result.json;
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "unknown AI failure";
      const transient = isTransientAiError(err);
      const nextCount = log.retry_count + 1;

      if (transient && nextCount < env.maxDeliveryRetries) {
        const delayMs = backoffDelayMs(log.retry_count);
        await supabase
          .from("webhook_logs")
          .update({
            status: "pending" as WebhookLogStatus,
            retry_count: nextCount,
            next_retry_at: new Date(Date.now() + delayMs).toISOString(),
            error_message: `AI retry ${nextCount}: ${message}`.slice(0, 2000),
          })
          .eq("id", log.id);
        aiRequeued++;
      } else {
        await supabase
          .from("webhook_logs")
          .update({
            status: "failed_ai" as WebhookLogStatus,
            next_retry_at: null,
            error_message: (transient
              ? `AI retries exhausted: ${message}`
              : message
            ).slice(0, 2000),
          })
          .eq("id", log.id);
        aiFailed++;
      }
      continue;
    }

    await supabase
      .from("webhook_logs")
      .update({ parsed_json_output: parsedJson })
      .eq("id", log.id);

    const outboundBody = buildOutboundBody({
      endpointId: endpoint.id,
      logId: log.id,
      receivedAt: (raw.Date as string | undefined) ?? new Date().toISOString(),
      source: {
        from: fromFull?.Email ?? (raw.From as string) ?? null,
        subject: (raw.Subject as string) ?? null,
        message_id: (raw.MessageID as string) ?? null,
      },
      data: parsedJson,
    });

    const result = await deliver(
      endpoint.target_webhook_url,
      endpoint.webhook_secret,
      log.id,
      outboundBody,
    );

    // A failed delivery hands off to the existing retry-deliveries
    // worker with a fresh budget (retry_count reset; the AI-stage
    // retry_count is not charged against delivery attempts).
    await supabase
      .from("webhook_logs")
      .update({
        status: (result.delivered
          ? "success"
          : "failed_delivery") as WebhookLogStatus,
        http_response_code: result.httpStatus,
        retry_count: 0,
        next_retry_at: null,
        error_message: result.delivered
          ? null
          : result.errorMessage?.slice(0, 2000) ?? "delivery failed",
      })
      .eq("id", log.id);

    if (result.delivered) delivered++;
    else deliveryFailed++;
  }

  return NextResponse.json({
    ok: true,
    claimed: ids.length,
    delivered,
    delivery_failed: deliveryFailed,
    ai_requeued: aiRequeued,
    ai_failed: aiFailed,
    deferred,
  });
}

export async function GET(req: NextRequest) {
  return handle(req);
}

export async function POST(req: NextRequest) {
  return handle(req);
}
