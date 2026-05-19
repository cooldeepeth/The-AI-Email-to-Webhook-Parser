import { NextRequest, NextResponse } from "next/server";
import { authenticate } from "@/lib/auth";
import { getServiceClient } from "@/lib/supabase";
import { getStripe } from "@/lib/stripe";
import { env } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/v1/billing/checkout — start a Stripe Checkout for Hosted Pro.
// Returns { url } for the browser to redirect to.
export async function POST(req: NextRequest) {
  const auth = await authenticate(req);
  if (!auth.ok) return auth.response;
  const { userId } = auth.ctx;

  const stripe = getStripe();
  const svc = getServiceClient();

  // Reuse the account's Stripe customer if it already has one; otherwise
  // create it and persist the id now so the webhook can resolve the user.
  const { data: account } = await svc
    .from("billing_accounts")
    .select("stripe_customer_id,plan")
    .eq("user_id", userId)
    .maybeSingle<{ stripe_customer_id: string | null; plan: string }>();

  if (account?.plan === "pro") {
    return NextResponse.json(
      { ok: false, error: "already_subscribed" },
      { status: 409 },
    );
  }

  let customerId = account?.stripe_customer_id ?? null;
  if (!customerId) {
    const { data: userData } = await auth.ctx.supabase.auth.getUser();
    const customer = await stripe.customers.create({
      email: userData.user?.email ?? undefined,
      metadata: { supabase_user_id: userId },
    });
    customerId = customer.id;
    await svc
      .from("billing_accounts")
      .upsert(
        { user_id: userId, stripe_customer_id: customerId },
        { onConflict: "user_id" },
      );
  }

  const origin = env.appUrl ?? req.nextUrl.origin;

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    client_reference_id: userId,
    line_items: [{ price: env.stripeProPriceId, quantity: 1 }],
    subscription_data: { metadata: { supabase_user_id: userId } },
    success_url: `${origin}/?upgraded=1`,
    cancel_url: `${origin}/pricing`,
    allow_promotion_codes: true,
  });

  if (!session.url) {
    return NextResponse.json(
      { ok: false, error: "checkout_session_failed" },
      { status: 502 },
    );
  }
  return NextResponse.json({ ok: true, url: session.url });
}
