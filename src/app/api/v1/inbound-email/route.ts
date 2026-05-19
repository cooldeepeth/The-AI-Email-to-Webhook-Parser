import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";
import { getServiceClient } from "@/lib/supabase";
import { parseEmailWithAi } from "@/lib/ai";
import { buildOutboundBody, deliver } from "@/lib/dispatch";
import type {
  EndpointRow,
  PostmarkInboundPayload,
  WebhookLogStatus,
} from "@/lib/types";

// HMAC + outbound fetch require the Node runtime (not Edge).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function jsonResponse(status: number, body: Record<string, unknown>) {
  return NextResponse.json(body, { status });
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * Postmark does not HMAC-sign inbound payloads, so the recommended
 * protection is a secret embedded in the webhook URL/credentials. We
 * accept HTTP Basic auth, a Bearer token, an X-Postmark-Token header, or
 * a ?token= query param so the URL can be configured either way.
 */
function isAuthorized(req: NextRequest): boolean {
  let token: string;
  try {
    token = env.postmarkInboundToken;
  } catch {
    return false;
  }

  const auth = req.headers.get("authorization") ?? "";
  if (auth.startsWith("Basic ")) {
    try {
      const decoded = Buffer.from(auth.slice(6), "base64").toString("utf8");
      const password = decoded.slice(decoded.indexOf(":") + 1);
      if (safeEqual(password, token)) return true;
    } catch {
      /* fall through */
    }
  }
  if (auth.startsWith("Bearer ") && safeEqual(auth.slice(7), token)) {
    return true;
  }

  const headerToken = req.headers.get("x-postmark-token");
  if (headerToken && safeEqual(headerToken, token)) return true;

  const queryToken = req.nextUrl.searchParams.get("token");
  if (queryToken && safeEqual(queryToken, token)) return true;

  return false;
}

/** Resolve the endpoint slug from the recipient local-part. */
function extractSlug(payload: PostmarkInboundPayload): string | null {
  const recipients = (payload.ToFull ?? []).filter((r) => r?.Email);
  const domain = env.inboundEmailDomain;

  let chosen = recipients[0]?.Email;
  if (domain) {
    const match = recipients.find((r) =>
      r.Email?.toLowerCase().endsWith(`@${domain}`),
    );
    if (match?.Email) chosen = match.Email;
  }
  if (!chosen && payload.To) chosen = payload.To.split(",")[0]?.trim();
  if (!chosen) return null;

  // local-part, dropping any Postmark "+hash" suffix.
  const localPart = chosen.split("@")[0]?.trim().toLowerCase();
  if (!localPart) return null;
  const slug = localPart.split("+")[0];
  return slug || null;
}

/** Strip base64 attachment bodies before persisting raw payload as JSONB. */
function sanitizePayload(payload: PostmarkInboundPayload) {
  const clone: Record<string, unknown> = { ...payload };
  if (Array.isArray(payload.Attachments)) {
    clone.Attachments = payload.Attachments.map((a) => ({
      Name: a.Name,
      ContentType: a.ContentType,
      ContentLength: a.ContentLength,
      ContentID: a.ContentID,
    }));
  }
  return clone;
}

export async function POST(req: NextRequest) {
  // 0. Authenticate the caller before doing any work.
  if (!isAuthorized(req)) {
    return jsonResponse(401, { ok: false, error: "unauthorized" });
  }

  // 1. Receive & validate the Postmark payload.
  let payload: PostmarkInboundPayload;
  try {
    payload = (await req.json()) as PostmarkInboundPayload;
  } catch {
    return jsonResponse(400, { ok: false, error: "invalid_json_body" });
  }
  if (!payload || typeof payload !== "object") {
    return jsonResponse(400, { ok: false, error: "invalid_payload" });
  }

  const slug = extractSlug(payload);
  if (!slug) {
    // 2xx so Postmark does not retry an inherently undeliverable email.
    return jsonResponse(200, {
      ok: false,
      error: "recipient_slug_not_found",
    });
  }

  const supabase = getServiceClient();

  // 2. Match the active endpoint.
  const { data: endpoint, error: lookupError } = await supabase
    .from("endpoints")
    .select(
      "id,user_id,name,inbound_email_slug,target_webhook_url,webhook_secret,ai_prompt_schema,is_active",
    )
    .eq("inbound_email_slug", slug)
    .eq("is_active", true)
    .maybeSingle<EndpointRow>();

  if (lookupError) {
    return jsonResponse(500, { ok: false, error: "endpoint_lookup_failed" });
  }
  if (!endpoint) {
    return jsonResponse(200, {
      ok: false,
      error: "no_active_endpoint_for_slug",
      slug,
    });
  }

  // 3. Enforce the account's monthly quota before any paid AI work.
  // Counting happens here (an accepted email) so rejected/over-quota
  // mail is recorded but never consumes an LLM call.
  const { data: quota, error: quotaError } = await supabase
    .rpc("record_usage_and_check", { p_user_id: endpoint.user_id })
    .single<{ allowed: boolean; used: number; monthly_quota: number }>();

  if (quotaError || !quota) {
    return jsonResponse(500, { ok: false, error: "usage_check_failed" });
  }
  if (!quota.allowed) {
    await supabase.from("webhook_logs").insert({
      endpoint_id: endpoint.id,
      status: "quota_exceeded" as WebhookLogStatus,
      raw_email_payload: sanitizePayload(payload),
      error_message: `monthly quota exceeded (${quota.used}/${quota.monthly_quota})`,
    });
    return jsonResponse(200, {
      ok: false,
      error: "quota_exceeded",
      used: quota.used,
      monthly_quota: quota.monthly_quota,
    });
  }

  // 4. Log the initial 'processing' state.
  const { data: logRow, error: insertError } = await supabase
    .from("webhook_logs")
    .insert({
      endpoint_id: endpoint.id,
      status: "processing" as WebhookLogStatus,
      raw_email_payload: sanitizePayload(payload),
    })
    .select("id")
    .single<{ id: string }>();

  if (insertError || !logRow) {
    return jsonResponse(500, { ok: false, error: "log_insert_failed" });
  }
  const logId = logRow.id;

  const updateLog = async (patch: Record<string, unknown>) => {
    const { error } = await supabase
      .from("webhook_logs")
      .update(patch)
      .eq("id", logId);
    if (error) {
      console.error(`[thook] failed to update log ${logId}:`, error.message);
    }
  };

  // 5. AI parsing.
  const emailBody =
    payload.TextBody?.trim() ||
    payload.StrippedTextReply?.trim() ||
    payload.HtmlBody?.trim() ||
    "";

  let parsedJson: Record<string, unknown>;
  try {
    const result = await parseEmailWithAi({
      schemaInstructions: endpoint.ai_prompt_schema,
      subject: payload.Subject ?? "",
      from: payload.FromFull?.Email ?? payload.From ?? "",
      body: emailBody,
    });
    parsedJson = result.json;
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "unknown AI failure";
    await updateLog({
      status: "failed_ai" as WebhookLogStatus,
      error_message: message.slice(0, 2000),
    });
    return jsonResponse(200, { ok: false, stage: "ai", error: message });
  }

  await updateLog({ parsed_json_output: parsedJson });

  // 6. Dispatch the signed webhook to the developer's server.
  const outboundBody = buildOutboundBody({
    endpointId: endpoint.id,
    logId,
    receivedAt: payload.Date ?? new Date().toISOString(),
    source: {
      from: payload.FromFull?.Email ?? payload.From ?? null,
      subject: payload.Subject ?? null,
      message_id: payload.MessageID ?? null,
    },
    data: parsedJson,
  });

  const result = await deliver(
    endpoint.target_webhook_url,
    endpoint.webhook_secret,
    logId,
    outboundBody,
  );

  // 7. Final log update based on the developer server's response.
  // A failed delivery stays in 'failed_delivery' for the cron retry
  // worker; retry_count starts at 0 (no attempts beyond this one yet).
  await updateLog({
    status: (result.delivered
      ? "success"
      : "failed_delivery") as WebhookLogStatus,
    http_response_code: result.httpStatus,
    error_message: result.errorMessage?.slice(0, 2000) ?? null,
  });

  return jsonResponse(200, {
    ok: result.delivered,
    log_id: logId,
    http_response_code: result.httpStatus,
  });
}

export function GET() {
  return jsonResponse(405, { ok: false, error: "method_not_allowed" });
}
