import { NextRequest, NextResponse } from "next/server";
import { authenticate } from "@/lib/auth";
import { getServiceClient } from "@/lib/supabase";
import { getStripe } from "@/lib/stripe";
import { env } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/v1/billing/portal — open the Stripe billing portal so a
// subscriber can update payment details or cancel. Returns { url }.
export async function POST(req: NextRequest) {
  const auth = await authenticate(req);
  if (!auth.ok) return auth.response;

  const svc = getServiceClient();
  const { data: account } = await svc
    .from("billing_accounts")
    .select("stripe_customer_id")
    .eq("user_id", auth.ctx.userId)
    .maybeSingle<{ stripe_customer_id: string | null }>();

  if (!account?.stripe_customer_id) {
    return NextResponse.json(
      { ok: false, error: "no_billing_account" },
      { status: 404 },
    );
  }

  const origin = env.appUrl ?? req.nextUrl.origin;
  const session = await getStripe().billingPortal.sessions.create({
    customer: account.stripe_customer_id,
    return_url: `${origin}/`,
  });

  return NextResponse.json({ ok: true, url: session.url });
}
