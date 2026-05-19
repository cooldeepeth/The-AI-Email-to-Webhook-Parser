import { NextRequest, NextResponse } from "next/server";
import type Stripe from "stripe";
import { getStripe } from "@/lib/stripe";
import { getServiceClient } from "@/lib/supabase";
import { env } from "@/lib/env";
import { PLAN_QUOTA, type HostedPlan } from "@/lib/plans";

// Raw body is required for signature verification, so this must run on
// the Node runtime and must not be statically optimised.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function applyPlan(
  userId: string,
  plan: HostedPlan,
  customerId: string | null,
  subscriptionId: string | null,
) {
  const { error } = await getServiceClient().rpc("set_account_plan", {
    p_user_id: userId,
    p_plan: plan,
    p_quota: PLAN_QUOTA[plan],
    p_customer_id: customerId,
    p_subscription_id: subscriptionId,
  });
  if (error) {
    // Throwing yields a non-2xx so Stripe retries the delivery.
    throw new Error(`set_account_plan failed: ${error.message}`);
  }
}

/** Resolve our user id from a subscription's metadata or its customer. */
async function userIdForSubscription(
  sub: Stripe.Subscription,
): Promise<string | null> {
  const fromMeta = sub.metadata?.supabase_user_id;
  if (fromMeta) return fromMeta;

  const customerId =
    typeof sub.customer === "string" ? sub.customer : sub.customer.id;
  const { data } = await getServiceClient()
    .from("billing_accounts")
    .select("user_id")
    .eq("stripe_customer_id", customerId)
    .maybeSingle<{ user_id: string }>();
  return data?.user_id ?? null;
}

const ACTIVE_STATUSES = new Set<Stripe.Subscription.Status>([
  "active",
  "trialing",
  "past_due", // still entitled while Stripe retries payment
]);

export async function POST(req: NextRequest) {
  const sig = req.headers.get("stripe-signature");
  if (!sig) {
    return NextResponse.json(
      { ok: false, error: "missing_signature" },
      { status: 400 },
    );
  }

  let event: Stripe.Event;
  try {
    const raw = await req.text();
    event = getStripe().webhooks.constructEvent(
      raw,
      sig,
      env.stripeWebhookSecret,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "bad_signature";
    return NextResponse.json(
      { ok: false, error: "signature_verification_failed", message },
      { status: 400 },
    );
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const s = event.data.object as Stripe.Checkout.Session;
        const userId = s.client_reference_id;
        if (userId && s.subscription) {
          await applyPlan(
            userId,
            "pro",
            typeof s.customer === "string" ? s.customer : null,
            typeof s.subscription === "string" ? s.subscription : null,
          );
        }
        break;
      }

      case "customer.subscription.updated": {
        const sub = event.data.object as Stripe.Subscription;
        const userId = await userIdForSubscription(sub);
        if (userId) {
          const plan: HostedPlan = ACTIVE_STATUSES.has(sub.status)
            ? "pro"
            : "free";
          await applyPlan(
            userId,
            plan,
            typeof sub.customer === "string" ? sub.customer : sub.customer.id,
            plan === "pro" ? sub.id : null,
          );
        }
        break;
      }

      case "customer.subscription.deleted": {
        const sub = event.data.object as Stripe.Subscription;
        const userId = await userIdForSubscription(sub);
        if (userId) {
          await applyPlan(
            userId,
            "free",
            typeof sub.customer === "string" ? sub.customer : sub.customer.id,
            null,
          );
        }
        break;
      }

      default:
        // Unhandled events are acknowledged so Stripe stops retrying.
        break;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "handler_failed";
    console.error(`[thook] stripe webhook ${event.type}:`, message);
    return NextResponse.json(
      { ok: false, error: "handler_failed" },
      { status: 500 },
    );
  }

  return NextResponse.json({ received: true });
}
