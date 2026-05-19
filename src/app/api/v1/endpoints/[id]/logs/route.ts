import { NextRequest, NextResponse } from "next/server";
import { authenticate } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STATUSES = new Set([
  "received",
  "processing",
  "success",
  "failed_ai",
  "failed_delivery",
  "quota_exceeded",
]);

// Summary columns only — raw/parsed payloads are fetched per-log.
const LIST_COLUMNS =
  "id,endpoint_id,status,http_response_code,retry_count," +
  "error_message,created_at,updated_at";

// GET /api/v1/endpoints/{id}/logs?status=&limit=&offset=
export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const auth = await authenticate(req);
  if (!auth.ok) return auth.response;

  const sp = req.nextUrl.searchParams;

  const status = sp.get("status");
  if (status && !STATUSES.has(status)) {
    return NextResponse.json(
      { ok: false, error: "invalid_status_filter" },
      { status: 400 },
    );
  }

  const limit = Math.min(
    Math.max(Number(sp.get("limit") ?? "25") || 25, 1),
    100,
  );
  const offset = Math.max(Number(sp.get("offset") ?? "0") || 0, 0);

  let query = auth.ctx.supabase
    .from("webhook_logs")
    .select(LIST_COLUMNS, { count: "exact" })
    .eq("endpoint_id", params.id)
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (status) query = query.eq("status", status);

  const { data, error, count } = await query;

  if (error) {
    return NextResponse.json(
      { ok: false, error: "query_failed", detail: error.message },
      { status: 500 },
    );
  }
  return NextResponse.json({
    ok: true,
    logs: data ?? [],
    pagination: { limit, offset, total: count ?? 0 },
  });
}
