import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";
import { getServiceClient } from "@/lib/supabase";
import { buildOutboundBody, deliver } from "@/lib/dispatch";
import { isEligible } from "@/lib/retry";
import type { WebhookLogStatus } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

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
  updated_at: string;
  raw_email_payload: Record<string, unknown> | null;
  parsed_json_output: Record<string, unknown> | null;
  endpoint:
    | {
        id: string;
        target_webhook_url: string;
        webhook_secret: string;
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

  // Over-fetch by status/retry_count in SQL, then apply the time-based
  // backoff filter in JS (Supabase has no expression filter for it).
  const { data, error } = await supabase
    .from("webhook_logs")
    .select(
      "id,retry_count,updated_at,raw_email_payload,parsed_json_output," +
        "endpoint:endpoints(id,target_webhook_url,webhook_secret,is_active)",
    )
    .eq("status", "failed_delivery")
    .lt("retry_count", env.maxDeliveryRetries)
    .order("updated_at", { ascending: true })
    .limit(env.retryBatchSize * 4)
    .returns<JoinedLog[]>();

  if (error) {
    return NextResponse.json(
      { ok: false, error: "query_failed", detail: error.message },
      { status: 500 },
    );
  }

  const eligible = (data ?? [])
    .filter((l) => isEligible(l.retry_count, l.updated_at))
    .slice(0, env.retryBatchSize);

  let succeeded = 0;
  let stillFailing = 0;
  let skipped = 0;

  for (const log of eligible) {
    const endpoint = log.endpoint;
    if (!endpoint || !endpoint.is_active || !log.parsed_json_output) {
      // Endpoint deleted/disabled or nothing parsed to deliver — stop
      // retrying by parking it at the retry ceiling.
      await supabase
        .from("webhook_logs")
        .update({
          retry_count: env.maxDeliveryRetries,
          error_message:
            "retry abandoned: endpoint inactive/missing or no parsed output",
        })
        .eq("id", log.id);
      skipped++;
      continue;
    }

    const raw = log.raw_email_payload ?? {};
    const fromFull = raw.FromFull as { Email?: string } | undefined;
    const body = buildOutboundBody({
      endpointId: endpoint.id,
      logId: log.id,
      receivedAt:
        (raw.Date as string | undefined) ?? new Date().toISOString(),
      source: {
        from: fromFull?.Email ?? (raw.From as string) ?? null,
        subject: (raw.Subject as string) ?? null,
        message_id: (raw.MessageID as string) ?? null,
      },
      data: log.parsed_json_output,
    });

    const result = await deliver(
      endpoint.target_webhook_url,
      endpoint.webhook_secret,
      log.id,
      body,
    );

    await supabase
      .from("webhook_logs")
      .update({
        status: (result.delivered
          ? "success"
          : "failed_delivery") as WebhookLogStatus,
        http_response_code: result.httpStatus,
        retry_count: log.retry_count + 1,
        error_message: result.delivered
          ? null
          : result.errorMessage?.slice(0, 2000) ?? "delivery failed",
      })
      .eq("id", log.id);

    if (result.delivered) succeeded++;
    else stillFailing++;
  }

  return NextResponse.json({
    ok: true,
    scanned: data?.length ?? 0,
    attempted: eligible.length,
    succeeded,
    still_failing: stillFailing,
    skipped,
  });
}

export async function GET(req: NextRequest) {
  return handle(req);
}

export async function POST(req: NextRequest) {
  return handle(req);
}
