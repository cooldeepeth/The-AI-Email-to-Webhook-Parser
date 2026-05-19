import { NextRequest, NextResponse } from "next/server";
import { authenticate } from "@/lib/auth";
import { SLUG_RE, isHttpUrl, isNonEmptyString } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FULL_COLUMNS =
  "id,name,inbound_email_slug,target_webhook_url,ai_prompt_schema," +
  "is_active,webhook_secret,created_at,updated_at";

type Params = { params: { id: string } };

// GET /api/v1/endpoints/{id}
export async function GET(req: NextRequest, { params }: Params) {
  const auth = await authenticate(req);
  if (!auth.ok) return auth.response;

  const { data, error } = await auth.ctx.supabase
    .from("endpoints")
    .select(FULL_COLUMNS)
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
  return NextResponse.json({ ok: true, endpoint: data });
}

// PATCH /api/v1/endpoints/{id} — partial update of mutable fields.
export async function PATCH(req: NextRequest, { params }: Params) {
  const auth = await authenticate(req);
  if (!auth.ok) return auth.response;

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json(
      { ok: false, error: "invalid_json_body" },
      { status: 400 },
    );
  }

  const patch: Record<string, unknown> = {};

  if ("name" in body) {
    if (!isNonEmptyString(body.name)) {
      return NextResponse.json(
        { ok: false, error: "invalid_name" },
        { status: 400 },
      );
    }
    patch.name = body.name.trim();
  }
  if ("target_webhook_url" in body) {
    if (!isHttpUrl(body.target_webhook_url)) {
      return NextResponse.json(
        { ok: false, error: "target_webhook_url_must_be_http_url" },
        { status: 400 },
      );
    }
    patch.target_webhook_url = body.target_webhook_url;
  }
  if ("ai_prompt_schema" in body) {
    if (!isNonEmptyString(body.ai_prompt_schema)) {
      return NextResponse.json(
        { ok: false, error: "invalid_ai_prompt_schema" },
        { status: 400 },
      );
    }
    patch.ai_prompt_schema = body.ai_prompt_schema;
  }
  if ("is_active" in body) {
    if (typeof body.is_active !== "boolean") {
      return NextResponse.json(
        { ok: false, error: "is_active_must_be_boolean" },
        { status: 400 },
      );
    }
    patch.is_active = body.is_active;
  }
  if ("inbound_email_slug" in body) {
    if (
      typeof body.inbound_email_slug !== "string" ||
      !SLUG_RE.test(body.inbound_email_slug)
    ) {
      return NextResponse.json(
        { ok: false, error: "invalid_slug_format" },
        { status: 400 },
      );
    }
    patch.inbound_email_slug = body.inbound_email_slug;
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json(
      { ok: false, error: "no_updatable_fields_provided" },
      { status: 400 },
    );
  }

  const { data, error } = await auth.ctx.supabase
    .from("endpoints")
    .update(patch)
    .eq("id", params.id)
    .select(FULL_COLUMNS)
    .maybeSingle();

  if (error) {
    if (error.code === "23505") {
      return NextResponse.json(
        { ok: false, error: "slug_already_taken" },
        { status: 409 },
      );
    }
    return NextResponse.json(
      { ok: false, error: "update_failed", detail: error.message },
      { status: 500 },
    );
  }
  if (!data) {
    return NextResponse.json(
      { ok: false, error: "not_found" },
      { status: 404 },
    );
  }
  return NextResponse.json({ ok: true, endpoint: data });
}

// DELETE /api/v1/endpoints/{id}
export async function DELETE(req: NextRequest, { params }: Params) {
  const auth = await authenticate(req);
  if (!auth.ok) return auth.response;

  const { data, error } = await auth.ctx.supabase
    .from("endpoints")
    .delete()
    .eq("id", params.id)
    .select("id")
    .maybeSingle();

  if (error) {
    return NextResponse.json(
      { ok: false, error: "delete_failed", detail: error.message },
      { status: 500 },
    );
  }
  if (!data) {
    return NextResponse.json(
      { ok: false, error: "not_found" },
      { status: 404 },
    );
  }
  return NextResponse.json({ ok: true, deleted_id: data.id });
}
