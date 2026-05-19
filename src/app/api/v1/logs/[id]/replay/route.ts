import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";
import { getServiceClient } from "@/lib/supabase";
import { buildOutboundBody, deliver } from "@/lib/dispatch";
import type { WebhookLogStatus } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * Admin-secret guarded for now (no end-user dashboard/auth yet). When the
 * dashboard ships this becomes an owner-scoped, session-authenticated route.
 */
function isAuthorized(req: NextRequest): boolean {
  let secret: string;
  try {
    secret = env.cronSecret;
  } catch {
    return false;
  }
  const auth = req.headers.get("authorization") ?? "";
  return auth.startsWith("Bearer ") && safeEqual(auth.slice(7), secret);
}

interface JoinedLog {
  id: string;
  parsed_json_output: Record<string, unknown> | null;
  raw_email_payload: Record<string, unknown> | null;
  endpoint:
    | {
        id: string;
        target_webhook_url: string;
        webhook_secret: string;
        is_active: boolean;
      }
    | null;
}

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  if (!isAuthorized(req)) {
    return NextResponse.json(
      { ok: false, error: "unauthorized" },
      { status: 401 },
    );
  }

  const supabase = getServiceClient();
  const { data: log, error } = await supabase
    .from("webhook_logs")
    .select(
      "id,parsed_json_output,raw_email_payload," +
        "endpoint:endpoints(id,target_webhook_url,webhook_secret,is_active)",
    )
    .eq("id", params.id)
    .maybeSingle<JoinedLog>();

  if (error) {
    return NextResponse.json(
      { ok: false, error: "query_failed", detail: error.message },
      { status: 500 },
    );
  }
  if (!log) {
    return NextResponse.json(
      { ok: false, error: "log_not_found" },
      { status: 404 },
    );
  }
  if (!log.parsed_json_output) {
    return NextResponse.json(
      { ok: false, error: "nothing_to_replay_no_parsed_output" },
      { status: 409 },
    );
  }
  if (!log.endpoint || !log.endpoint.is_active) {
    return NextResponse.json(
      { ok: false, error: "endpoint_inactive_or_missing" },
      { status: 409 },
    );
  }

  const raw = log.raw_email_payload ?? {};
  const fromFull = raw.FromFull as { Email?: string } | undefined;
  const body = buildOutboundBody({
    endpointId: log.endpoint.id,
    logId: log.id,
    receivedAt: (raw.Date as string | undefined) ?? new Date().toISOString(),
    source: {
      from: fromFull?.Email ?? (raw.From as string) ?? null,
      subject: (raw.Subject as string) ?? null,
      message_id: (raw.MessageID as string) ?? null,
    },
    data: log.parsed_json_output,
  });

  const result = await deliver(
    log.endpoint.target_webhook_url,
    log.endpoint.webhook_secret,
    log.id,
    body,
  );

  // Manual replay does not touch retry_count (it is an operator action,
  // not part of the automatic backoff sequence).
  await supabase
    .from("webhook_logs")
    .update({
      status: (result.delivered
        ? "success"
        : "failed_delivery") as WebhookLogStatus,
      http_response_code: result.httpStatus,
      error_message: result.delivered
        ? null
        : result.errorMessage?.slice(0, 2000) ?? "delivery failed",
    })
    .eq("id", log.id);

  return NextResponse.json({
    ok: result.delivered,
    log_id: log.id,
    http_response_code: result.httpStatus,
  });
}
