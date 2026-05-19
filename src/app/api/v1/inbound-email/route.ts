import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";
import { getServiceClient } from "@/lib/supabase";
import type {
  EndpointRow,
  PostmarkInboundPayload,
  WebhookLogStatus,
} from "@/lib/types";

// Service-role writes require the Node runtime (not Edge). This route is
// now I/O-only: it persists the raw payload and returns immediately, so
// it is in no danger of the serverless timeout. AI parsing and outbound
// dispatch happen in /api/v1/cron/process-pending.
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

  // 4. Persist the raw payload as 'pending' and return immediately.
  // The cron worker (process-pending) does the LLM parse + dispatch.
  // A 5xx here makes Postmark redeliver, which is what we want if we
  // failed to even durably store the email.
  const { data: logRow, error: insertError } = await supabase
    .from("webhook_logs")
    .insert({
      endpoint_id: endpoint.id,
      status: "pending" as WebhookLogStatus,
      raw_email_payload: sanitizePayload(payload),
    })
    .select("id")
    .single<{ id: string }>();

  if (insertError || !logRow) {
    return jsonResponse(500, { ok: false, error: "log_insert_failed" });
  }

  return jsonResponse(200, {
    ok: true,
    status: "pending",
    log_id: logRow.id,
  });
}

export function GET() {
  return jsonResponse(405, { ok: false, error: "method_not_allowed" });
}
