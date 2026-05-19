import { NextRequest, NextResponse } from "next/server";
import { authenticate } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/v1/logs/{id} — full log incl. raw + parsed payloads.
// RLS restricts visibility to logs whose endpoint the caller owns.
export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const auth = await authenticate(req);
  if (!auth.ok) return auth.response;

  const { data, error } = await auth.ctx.supabase
    .from("webhook_logs")
    .select(
      "id,endpoint_id,status,raw_email_payload,parsed_json_output," +
        "http_response_code,retry_count,error_message,created_at,updated_at",
    )
    .eq("id", params.id)
    .maybeSingle();

  if (error) {
    return NextResponse.json(
      { ok: false, error: "query_failed", detail: error.message },
      { status: 500 },
    );
  }
  if (!data) {
    return NextResponse.json(
      { ok: false, error: "not_found" },
      { status: 404 },
    );
  }
  return NextResponse.json({ ok: true, log: data });
}
