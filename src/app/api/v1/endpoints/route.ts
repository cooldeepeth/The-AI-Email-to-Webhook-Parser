import { NextRequest, NextResponse } from "next/server";
import { authenticate } from "@/lib/auth";
import {
  SLUG_RE,
  generateSlug,
  isHttpUrl,
  isNonEmptyString,
} from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PUBLIC_COLUMNS =
  "id,name,inbound_email_slug,target_webhook_url,ai_prompt_schema," +
  "is_active,created_at,updated_at";

// GET /api/v1/endpoints — list the caller's endpoints (no secrets).
export async function GET(req: NextRequest) {
  const auth = await authenticate(req);
  if (!auth.ok) return auth.response;

  const { data, error } = await auth.ctx.supabase
    .from("endpoints")
    .select(PUBLIC_COLUMNS)
    .order("created_at", { ascending: false });

  if (error) {
    return NextResponse.json(
      { ok: false, error: "query_failed", detail: error.message },
      { status: 500 },
    );
  }
  return NextResponse.json({ ok: true, endpoints: data ?? [] });
}

// POST /api/v1/endpoints — create an endpoint.
export async function POST(req: NextRequest) {
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

  if (!isNonEmptyString(body.name)) {
    return NextResponse.json(
      { ok: false, error: "name_required" },
      { status: 400 },
    );
  }
  if (!isHttpUrl(body.target_webhook_url)) {
    return NextResponse.json(
      { ok: false, error: "target_webhook_url_must_be_http_url" },
      { status: 400 },
    );
  }
  if (!isNonEmptyString(body.ai_prompt_schema)) {
    return NextResponse.json(
      { ok: false, error: "ai_prompt_schema_required" },
      { status: 400 },
    );
  }

  const userSlug = body.inbound_email_slug;
  let slug: string;
  let slugIsUserChosen = false;
  if (userSlug !== undefined && userSlug !== null && userSlug !== "") {
    if (typeof userSlug !== "string" || !SLUG_RE.test(userSlug)) {
      return NextResponse.json(
        { ok: false, error: "invalid_slug_format" },
        { status: 400 },
      );
    }
    slug = userSlug;
    slugIsUserChosen = true;
  } else {
    slug = generateSlug();
  }

  const base = {
    user_id: auth.ctx.userId,
    name: body.name.trim(),
    target_webhook_url: body.target_webhook_url,
    ai_prompt_schema: body.ai_prompt_schema,
    is_active: typeof body.is_active === "boolean" ? body.is_active : true,
  };

  // Auto-generated slugs can collide; retry a few times. A user-chosen
  // collision is reported instead of silently changed.
  for (let attempt = 0; attempt < 4; attempt++) {
    const { data, error } = await auth.ctx.supabase
      .from("endpoints")
      .insert({ ...base, inbound_email_slug: slug })
      .select(`${PUBLIC_COLUMNS},webhook_secret`)
      .single();

    if (!error) {
      return NextResponse.json({ ok: true, endpoint: data }, { status: 201 });
    }
    if (error.code === "23505") {
      if (slugIsUserChosen) {
        return NextResponse.json(
          { ok: false, error: "slug_already_taken" },
          { status: 409 },
        );
      }
      slug = generateSlug();
      continue;
    }
    return NextResponse.json(
      { ok: false, error: "create_failed", detail: error.message },
      { status: 500 },
    );
  }

  return NextResponse.json(
    { ok: false, error: "could_not_allocate_unique_slug" },
    { status: 500 },
  );
}
