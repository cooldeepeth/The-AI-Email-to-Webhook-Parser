import { NextRequest, NextResponse } from "next/server";
import { authenticate } from "@/lib/auth";
import { generateWebhookSecret } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/v1/endpoints/{id}/rotate-secret
// Returns the new secret once — the caller must store it to keep
// verifying signatures.
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const auth = await authenticate(req);
  if (!auth.ok) return auth.response;

  const { data, error } = await auth.ctx.supabase
    .from("endpoints")
    .update({ webhook_secret: generateWebhookSecret() })
    .eq("id", params.id)
    .select("id,webhook_secret")
    .maybeSingle();

  if (error) {
    return NextResponse.json(
      { ok: false, error: "rotate_failed", detail: error.message },
      { status: 500 },
    );
  }
  if (!data) {
    return NextResponse.json(
      { ok: false, error: "not_found" },
      { status: 404 },
    );
  }
  return NextResponse.json({
    ok: true,
    endpoint_id: data.id,
    webhook_secret: data.webhook_secret,
  });
}
